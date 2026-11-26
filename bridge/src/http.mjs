// The local endpoint every surface reads: the notch, the menu-bar panel and the
// DSH plugin.
//
// Sessions are read and turn transitions are decided on one timer, never inside
// a request, so three pollers cannot change the outcome. Requests are served
// from the latest snapshot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { readSessions } from './sessions.mjs';
import { readCodexSessions, readClaudeSessions, primeCodexTitles } from './providers.mjs';
import { readAntigravitySessions } from './provider-antigravity.mjs';
import { readCursorSessions, recordCursorHook } from './provider-cursor.mjs';
import { readGrokSessions, recordGrokHook } from './provider-grok.mjs';
import { createTracker, openedSince, statusOf } from './status.mjs';
import { exhaustedProviders, readCodexQuota, readQuota } from './quota.mjs';
import { createAlerts } from './alerts.mjs';
import { dshIsFrontmost } from './focus.mjs';
import { currentSessionId } from './store.mjs';
import { DATA_DIR, PROVIDER_IDS, STATE_FILE, TOKEN_FILE, VERSION, normalizeAlerts, readConfig, resetPreferences, validProxyUrl, writeConfig } from './config.mjs';
import { buildDiagnostics } from './diagnostics.mjs';
import { currentRoute } from './egress.mjs';
import { checkForUpdate, downloadUpdate, startUpdateChecks, updateStatus } from './update.mjs';
import {
  connectCursorHooks, connectDeepSeek, connectGrokHooks, detectTools,
  disconnectCursorHooks, disconnectDeepSeek, disconnectGrokHooks, syncDeepSeekPlugin,
} from './integrations.mjs';
import { deleteKey, hasKey, lastBalance, refreshBalanceNow, saveKey, validKeyShape } from './deepseek-balance.mjs';

// A small JSON body (the API key), never put in a URL where logs could keep it.
function readJsonBody(req, limit = 2048) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export const STATE_PORT = Number(process.env.FIRE_RING_PORT ?? 47821);

const REFRESH_MS = Number(process.env.FIRE_RING_REFRESH_MS ?? 800);
const LONG_POLL_MS = 25_000;
const PEEK_SECONDS_DEFAULT = 6;
const validPeekSeconds = (n) => Number.isInteger(n) && n >= 3 && n <= 12;
const PENDING_OPEN_TTL_MS = 30_000;
const PENDING_INTERACTION_TTL_MS = 30 * 60_000;

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const DSH_ORIGIN = 'dsh-app://app'; // the DSH desktop page, where the plugin runs

// 刘海的选项：全屏 App 里怎样。
const NOTCH_CHOICES = {
  fullscreen: ['hide', 'waiting', 'show'],
};
const pick = (value, choices) => (choices.includes(value) ? value : choices[0]);

function readState() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    /* first run: defaults */
  }
  return {
    islandEnabled: raw.islandEnabled !== false,
    autoPeek: raw.autoPeek !== false,
    peekWait: raw.peekWait !== false,
    peekSeconds: validPeekSeconds(raw.peekSeconds) ? raw.peekSeconds : PEEK_SECONDS_DEFAULT,
    fullscreen: pick(raw.fullscreen, NOTCH_CHOICES.fullscreen),
    finishedAt: raw.finishedAt && typeof raw.finishedAt === 'object' ? raw.finishedAt : {},
    // 手动清掉的「等你」：id -> 清除时这条对话的最后更新时间。对话有新动静就失效。
    ignoredWaiting: raw.ignoredWaiting && typeof raw.ignoredWaiting === 'object' ? raw.ignoredWaiting : {},
  };
}

const notchPrefs = (state) => ({
  islandEnabled: state.islandEnabled,
  autoPeek: state.autoPeek,
  peekWait: state.peekWait,
  peekSeconds: state.peekSeconds,
  fullscreen: state.fullscreen,
});

function writeState(next) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch (error) {
    console.error('state write failed:', error.message);
  }
}

// The notch and panel pages load from file://, so their Origin is "null", which
// a sandboxed iframe on any website can also claim. The token tells them apart;
// the app reads the same file and hands it to its pages.
function loadToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomUUID();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function startStateServer(port = STATE_PORT) {
  const token = loadToken();
  let state = readState();
  let pendingOpen = null; // { id, at }, consumed by the DSH plugin
  // DeepSeek Harness 界面上的实时状态，由插件上报；比它写到硬盘的缓存早一两秒。
  let dshLive = null;     // { at, running: Set, pending: Set }
  const LIVE_FRESH_MS = 15_000;
  const liveDsh = () => (dshLive && Date.now() - dshLive.at < LIVE_FRESH_MS ? dshLive : null);
  const pendingInteractions = new Map(); // reported by the DSH plugin
  const rejectedOrigins = new Set();

  const tracker = createTracker({
    finished: state.finishedAt,
    onChange: (finishedAt) => {
      state = { ...state, finishedAt };
      writeState(state);
    },
  });

  const alerts = createAlerts({ codexQuota: () => readCodexQuota(), deepseekBalance: () => lastBalance() });
  let demo = { seq: 0, kind: null };   // 设置里「试一下」让刘海弹出的演示

  let snapshot = [];
  let revision = 0;
  let fingerprint = '';
  const waiters = new Set();

  // The surfaces long-poll: a held request is answered the moment anything they
  // show changes, so a change never waits for the next poll.
  function publish() {
    const shown = snapshot
      .map((s) => [s.id, s.status, s.title, s.project, s.finishedAt, s.lastPromptAt, s.open?.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const next = JSON.stringify([notchPrefs(state), updateBadge(), readConfig().providers, readConfig().quota, readConfig().theme,
      alerts.latest().seq, demo.seq, shown]);
    if (next === fingerprint) return;
    fingerprint = next;
    revision += 1;
    for (const wake of [...waiters]) wake();
  }

  // A short summary of the update state, so the menu panel can show a badge
  // without asking separately.
  function updateBadge() {
    const u = updateStatus();
    return ['available', 'downloading', 'ready'].includes(u.phase) && u.latest
      ? { phase: u.phase, version: u.latest.version }
      : null;
  }

  function decorate() {
    const staleBefore = Date.now() - PENDING_INTERACTION_TTL_MS;
    for (const [id, at] of pendingInteractions) if (at < staleBefore) pendingInteractions.delete(id);
    for (const s of snapshot) {
      // 原始的「等你」判断只算一次存下来；decorate 可能在同一份数据上再跑。
      if (s.provider === 'dsh') s.waitingRaw = s.pendingQuestions > 0 || pendingInteractions.has(s.id) || Boolean(liveDsh()?.pending.has(s.id));
      else if (s.waitingRaw === undefined) s.waitingRaw = Boolean(s.waiting);
      s.waiting = s.waitingRaw;
      const ignored = state.ignoredWaiting[s.id];
      if (ignored !== undefined) {
        if (s.waiting && ignored === (s.updatedAt ?? null)) s.waiting = false;
        else forgetIgnored(s.id);   // 不再等你，或者对话有了新动静
      }
      s.finishedAt = tracker.finishedAt(s.id);
      s.turnEndedAt = tracker.endedAt(s.id);
      s.finished = s.finishedAt !== null;
      s.status = statusOf(s);
    }
  }

  function forgetIgnored(id) {
    if (!(id in state.ignoredWaiting)) return;
    const next = { ...state.ignoredWaiting };
    delete next[id];
    state = { ...state, ignoredWaiting: next };
    writeState(state);
  }

  // A completion you have already opened in its own app is cleared here too.
  // DeepSeek: only after you left that conversation and came back to it, so a
  // turn that ends while you watch still shows as finished.
  const lookingAtDsh = (s) => dshIsFrontmost() && currentSessionId() === s.id;
  const awayAfterFinish = new Set();
  function clearViewed(sessions) {
    for (const s of sessions) {
      const finished = tracker.finishedAt(s.id);
      if (finished === null) { awayAfterFinish.delete(s.id); continue; }
      let looking = null;
      if (s.provider === 'dsh') {
        looking = lookingAtDsh(s);
        if (!looking) awayAfterFinish.add(s.id);
      }
      if (!openedSince(s, finished, { lookingAt: () => looking, wasAway: () => awayAfterFinish.has(s.id) })) continue;
      awayAfterFinish.delete(s.id);
      tracker.dismiss(s.id);
      console.log('[auto] cleared after opening it in', s.providerName || s.provider, s.id.slice(0, 8));
    }
  }

  function refresh() {
    const { providers } = readConfig();
    const live = liveDsh();
    const dsh = (providers.dsh ? readSessions() : []).map((s) => ({
      id: s.id,
      provider: 'dsh',
      providerName: 'DeepSeek',
      title: s.title,
      project: s.project,
      cwd: s.cwd,
      // 插件在线时以界面上的状态为准，否则看缓存
      running: live ? live.running.has(s.id) : s.running,
      completedTurns: s.completedTurns,
      waiting: false,
      pendingQuestions: s.pendingQuestions,
      lastPromptAt: s.lastPromptAt,
      updatedAt: s.cacheMtime,
      open: { kind: 'dsh' },
    }));
    let codex = [];
    let claude = [];
    let antigravity = [];
    let cursor = [];
    let grok = [];
    if (providers.codex) try { codex = readCodexSessions(); } catch { codex = []; }
    if (providers.claude) try { claude = readClaudeSessions(); } catch { claude = []; }
    if (providers.antigravity) try { antigravity = readAntigravitySessions(); } catch { antigravity = []; }
    if (providers.cursor) try { cursor = readCursorSessions(); } catch { cursor = []; }
    if (providers.grok) try { grok = readGrokSessions(); } catch { grok = []; }

    const sessions = [...dsh, ...codex, ...claude, ...antigravity, ...cursor, ...grok]
      .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.updatedAt - a.updatedAt);
    // Nothing can run on a platform whose usage limit is used up.
    const exhausted = exhaustedProviders();
    for (const s of sessions) {
      if (s.running && exhausted.has(s.provider)) Object.assign(s, { running: false, quietEnd: true, limitHidden: true });
    }
    tracker.update(sessions);
    clearViewed(sessions);
    snapshot = sessions;
    decorate();
    logChanges();
    try { alerts.observe(snapshot); } catch (error) { console.error('alerts failed:', error.message); }
    publish();
  }

  // Each change of a session's status, with why, so a wrong state can be traced
  // later. Ids and statuses only; no conversation content.
  const lastStatus = new Map();
  let firstPass = true;
  function logChanges() {
    for (const s of snapshot) {
      const before = lastStatus.get(s.id);
      if (before === s.status) continue;
      lastStatus.set(s.id, s.status);
      if (firstPass || (!before && s.status === 'idle')) continue;
      const why = s.limitHidden ? '额度用完，按不在跑处理'
        : s.stale ? '超过 20 分钟没有新记录'
          : s.waiting ? '在等你'
            : s.quietEnd ? '被打断或额度拒绝'
              : s.status === 'finished' ? '这一轮结束'
                : s.status === 'running' ? '开始运行' : '';
      console.log('[status] ' + new Date().toISOString().slice(11, 19) + ' ' + (s.providerName || s.provider) + ' ' + s.id.slice(0, 8)
        + ' ' + (before || '新') + ' → ' + s.status + (why ? '（' + why + '）' : ''));
    }
    firstPass = false;
  }

  if (readConfig().providers.dsh) {
    try { syncDeepSeekPlugin(); } catch (error) { console.error('plugin update failed:', error.message); }
  }
  startUpdateChecks(() => publish());
  primeCodexTitles().catch(() => {});
  setInterval(() => { primeCodexTitles().catch(() => {}); }, 25_000).unref();
  refresh();
  setInterval(() => {
    try { refresh(); } catch (error) { console.error('refresh failed:', error.message); }
  }, REFRESH_MS);

  function access(req) {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return { ok: false };
    const origin = req.headers.origin;
    if (!origin) return { ok: true, trusted: false };
    if (LOCAL_ORIGIN.test(origin) || origin === DSH_ORIGIN) return { ok: true, trusted: true, origin };
    if (origin === 'null') {
      // A preflight cannot carry the token; the request that follows must.
      const allowed = req.method === 'OPTIONS' || req.headers['x-bridge-token'] === token;
      return allowed ? { ok: true, trusted: true, origin } : { ok: false, origin };
    }
    return { ok: false, origin };
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const allowed = access(req);
    if (!allowed.ok) {
      const key = allowed.origin ?? `host:${req.headers.host}`;
      if (!rejectedOrigins.has(key)) {
        rejectedOrigins.add(key);
        console.log('[security] rejected', key.slice(0, 120));
      }
      res.writeHead(403).end();
      return;
    }
    if (allowed.origin) {
      res.setHeader('Access-Control-Allow-Origin', allowed.origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'X-Bridge-Token');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const param = (name) => url.searchParams.get(name);
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/quota') {
      if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
      return json({ quota: readQuota(), at: Date.now() });
    }

    // Everything the settings window shows.
    if (url.pathname === '/app') {
      if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
      hasKey().then((deepseekKey) => json({
        version: VERSION,
        update: updateStatus(),
        config: readConfig(),
        notch: notchPrefs(state),
        route: currentRoute(),
        tools: detectTools().map((t) => (t.id === 'dsh' ? { ...t, live: Boolean(liveDsh()) } : t)),
        deepseek: { hasKey: deepseekKey, ...lastBalance() },
        at: Date.now(),
      }));
      return;
    }

    // 导出诊断信息：已经打码，不含对话内容
    if (url.pathname === '/diagnostics') {
      if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
      if (!allowed.trusted) return json({ error: 'forbidden' }, 403);
      hasKey().then((deepseekKey) => {
        const u = updateStatus();
        const text = buildDiagnostics({
          version: VERSION,
          route: currentRoute(),
          tools: detectTools().map((t) => ({ id: t.id, found: t.found, connected: t.connected, plugin: t.plugin })),
          config: readConfig(),
          notch: notchPrefs(state),
          deepseek: { hasKey: deepseekKey, state: lastBalance().state },
          update: { phase: u.phase, repo: u.repo, autoCheck: u.autoCheck, error: u.error || null },
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
      });
      return;
    }

    if (url.pathname === '/state') {
      if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
      const reply = () => {
        const open = pendingOpen && Date.now() - pendingOpen.at < PENDING_OPEN_TTL_MS ? pendingOpen.id : null;
        json({
          rev: revision,
          sessions: snapshot,
          pendingOpen: open,
          ...notchPrefs(state),
          alerts: alerts.latest(),
          demo,
          version: VERSION,
          update: updateBadge(),
          providers: readConfig().providers,
          quotaShown: readConfig().quota,
          theme: readConfig().theme,
          at: Date.now(),
        });
      };
      if (param('rev') === null || Number(param('rev')) !== revision) return reply();
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        reply();
      };
      const timer = setTimeout(finish, LONG_POLL_MS);
      waiters.add(finish);
      res.on('close', () => {
        clearTimeout(timer);
        waiters.delete(finish);
      });
      return;
    }

    const writes = ['/open', '/opened', '/dismiss', '/dismiss-finished', '/pending', '/island', '/autopeek', '/peek-seconds', '/notch-prefs', '/alerts/prefs', '/demo', '/reset', '/dsh-live', '/hook', '/log',
      '/config', '/update/check', '/update/download', '/setup/deepseek', '/setup/provider',
      '/deepseek/key', '/deepseek/recheck'];
    if (!writes.includes(url.pathname)) return json({ error: 'not found' }, 404);
    // A plain GET can be fired by an <img> on any page and carries no Origin, so
    // only POST, or a GET from a page we recognised, may change anything.
    if (req.method !== 'POST' && !allowed.trusted) return json({ error: 'POST only' }, 405);

    switch (url.pathname) {
      case '/open': {
        const id = param('id');
        if (!id) return json({ error: 'POST /open?id=<session>' }, 400);
        pendingOpen = { id, at: Date.now() };
        return json({ ok: true, pending: id });
      }
      case '/opened': {
        const was = pendingOpen?.id ?? null;
        pendingOpen = null;
        return json({ ok: true, cleared: was });
      }
      case '/dismiss': {
        const id = param('id');
        if (id) {
          // 清掉一条「等你」：这条对话没有新动静之前，不再算等你
          const session = snapshot.find((s) => s.id === id);
          if (session && session.waitingRaw) {
            state = { ...state, ignoredWaiting: { ...state.ignoredWaiting, [id]: session.updatedAt ?? null } };
            writeState(state);
            console.log('[ui] waiting dismissed', (session.providerName || session.provider), id.slice(0, 8));
          }
          tracker.dismiss(id);
          decorate();
          publish();
        }
        return json({ ok: true });
      }
      case '/dismiss-finished': {
        let cleared = 0;
        for (const s of snapshot) {
          if (tracker.finishedAt(s.id) === null) continue;
          tracker.dismiss(s.id);
          cleared += 1;
        }
        decorate();
        publish();
        return json({ ok: true, cleared });
      }
      case '/pending': {
        const session = param('session');
        if (session && /^[0-9a-f-]{36}$/.test(session)) {
          if (param('on') !== '0') pendingInteractions.set(session, Date.now());
          else pendingInteractions.delete(session);
          decorate();
          publish();
        }
        return json({ ok: true, pending: pendingInteractions.size });
      }
      case '/island': {
        const enabled = param('enabled') !== '0';
        state = { ...state, islandEnabled: enabled };
        writeState(state);
        console.log('[ui] island', enabled ? 'enabled' : 'disabled');
        publish();
        return json({ ok: true, islandEnabled: enabled });
      }
      case '/autopeek': {
        const enabled = param('enabled') !== '0';
        state = { ...state, autoPeek: enabled };
        writeState(state);
        console.log('[ui] auto peek', enabled ? 'enabled' : 'disabled');
        publish();
        return json({ ok: true, autoPeek: enabled });
      }
      case '/peek-seconds': {
        const seconds = Number(param('value'));
        if (!validPeekSeconds(seconds)) return json({ error: 'POST /peek-seconds?value=3..12' }, 400);
        state = { ...state, peekSeconds: seconds };
        writeState(state);
        publish();
        return json({ ok: true, peekSeconds: seconds });
      }
      case '/notch-prefs': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        const next = { ...state };
        if (param('peekWait') !== null) next.peekWait = param('peekWait') !== '0';
        for (const key of Object.keys(NOTCH_CHOICES)) {
          const value = param(key);
          if (value === null) continue;
          if (!NOTCH_CHOICES[key].includes(value)) return json({ error: key + ': ' + NOTCH_CHOICES[key].join(' | ') }, 400);
          next[key] = value;
        }
        state = next;
        writeState(state);
        publish();
        return json({ ok: true, notch: notchPrefs(state) });
      }
      case '/alerts/prefs': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        readJsonBody(req).then((body) => {
          if (!body || typeof body !== 'object') return json({ error: 'JSON body' }, 400);
          const current = readConfig().alerts;
          const merged = normalizeAlerts({
            ...current,
            ...body,
            sounds: { ...current.sounds, ...(body.sounds || {}) },
            notify: { ...current.notify, ...(body.notify || {}) },
            tools: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ...current.tools[id], ...((body.tools || {})[id] || {}) }])),
            dsLow: { ...current.dsLow, ...(body.dsLow || {}) },
          });
          const config = writeConfig({ alerts: merged });
          return json({ ok: true, alerts: config.alerts });
        });
        return;
      }
      case '/dsh-live': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        readJsonBody(req, 64 * 1024).then((body) => {
          const ids = (list) => new Set((Array.isArray(list) ? list : []).map(String).filter((id) => /^[0-9a-f-]{36}$/.test(id)));
          if (!body || typeof body !== 'object') return json({ error: 'JSON body' }, 400);
          const first = !dshLive;
          dshLive = { at: Date.now(), running: ids(body.running), pending: ids(body.pending) };
          if (first) console.log('[dsh] plugin reporting live status');
          try { refresh(); } catch (error) { console.error('refresh failed:', error.message); }
          return json({ ok: true });
        });
        return;
      }
      case '/hook': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        if (req.headers['x-bridge-token'] !== token && !allowed.trusted) return json({ error: 'forbidden' }, 403);
        const provider = param('provider');
        if (!['cursor', 'grok'].includes(provider)) return json({ error: 'provider: cursor | grok' }, 400);
        readJsonBody(req, 64 * 1024).then((body) => {
          if (!body || typeof body !== 'object') return json({ error: 'JSON body' }, 400);
          const ok = provider === 'cursor' ? recordCursorHook(body) : recordGrokHook(body);
          if (ok) try { refresh(); } catch (error) { console.error('refresh failed:', error.message); }
          return json({ ok });
        });
        return;
      }
      case '/reset': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        const config = resetPreferences();
        state = { ...readState(), ...notchPrefs({ islandEnabled: true, autoPeek: true, peekWait: true, peekSeconds: PEEK_SECONDS_DEFAULT,
          fullscreen: 'hide' }), finishedAt: state.finishedAt };
        writeState(state);
        console.log('[ui] settings reset to defaults');
        publish();
        return json({ ok: true, config, notch: notchPrefs(state) });
      }
      case '/demo': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        const kind = param('kind');
        if (!['wait', 'done'].includes(kind)) return json({ error: 'kind: wait | done' }, 400);
        demo = { seq: demo.seq + 1, kind };
        publish();
        return json({ ok: true });
      }
      case '/log':
        console.log('[ui]', (param('m') || '').slice(0, 300));
        return json({ ok: true });
      case '/config': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        const patch = {};
        const mode = param('proxyMode');
        if (mode !== null) {
          if (!['system', 'custom', 'direct', 'off'].includes(mode)) return json({ error: 'proxyMode: system | custom | direct | off' }, 400);
          const proxyUrl = (param('proxyUrl') ?? readConfig().proxy.url).trim();
          if (mode === 'custom' && !validProxyUrl(proxyUrl)) return json({ error: '代理地址要写成 http://主机:端口' }, 400);
          patch.proxy = { mode, url: proxyUrl };
        }
        if (param('autoCheck') !== null) patch.updates = { autoCheck: param('autoCheck') !== '0' };
        for (const id of PROVIDER_IDS) {
          const value = param('quota_' + id);
          if (value !== null) patch.quota = { ...(patch.quota || {}), [id]: value !== '0' };
        }
        if (param('onboarded') !== null) patch.onboarded = param('onboarded') !== '0';
        if (param('loginPrompt') !== null) patch.loginPrompt = param('loginPrompt') === 'never' ? 'never' : 'ask';
        if (param('theme') !== null) {
          if (!['dark', 'light', 'system'].includes(param('theme'))) return json({ error: 'theme: dark | light | system' }, 400);
          patch.theme = param('theme');
        }
        let config;
        try {
          config = writeConfig(patch);
        } catch (error) {
          return json({ error: error.message }, 409);
        }
        if (patch.proxy) {
          console.log('[config] network route: ' + currentRoute().label);
        }
        if (patch.quota || patch.theme) publish();   // the panel follows at once
        return json({ ok: true, config, route: currentRoute() });
      }
      case '/update/check':
        checkForUpdate().finally(() => publish());
        return json({ ok: true });
      case '/update/download':
        downloadUpdate().finally(() => publish());
        return json({ ok: true });
      // Connecting a tool: Fire Ring starts reading it and shows it everywhere.
      // DeepSeek Harness also gets its plugin installed (or removed).
      case '/setup/provider': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        const id = param('id');
        const on = param('on') !== '0';
        if (!PROVIDER_IDS.includes(id)) return json({ error: 'id: ' + PROVIDER_IDS.join(' | ') }, 400);
        let plugin = null;
        try {
          if (id === 'dsh') plugin = on ? connectDeepSeek() : disconnectDeepSeek();
          if (id === 'cursor') plugin = on ? connectCursorHooks() : disconnectCursorHooks();
          if (id === 'grok') plugin = on ? connectGrokHooks() : disconnectGrokHooks();
        } catch (error) {
          return json({ ok: false, error: error.message }, 500);
        }
        const config = writeConfig({ providers: { [id]: on } });
        console.log('[setup] ' + id + (on ? ' connected' : ' disconnected'));
        refresh();
        return json({ ok: true, providers: config.providers, plugin });
      }
      case '/setup/deepseek': {
        try {
          const plugin = param('on') === '0' ? disconnectDeepSeek() : connectDeepSeek();
          return json({ ok: true, plugin });
        } catch (error) {
          return json({ ok: false, error: error.message }, 500);
        }
      }
      // The DeepSeek API key: saved to the keychain and checked at once; the
      // answer says whether it worked, never what the key is.
      case '/deepseek/key': {
        if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
        if (param('clear') === '1') {
          deleteKey().then(() => { publish(); json({ ok: true, hasKey: false }); });
          return;
        }
        readJsonBody(req).then(async (body) => {
          const key = body && typeof body.key === 'string' ? body.key.trim() : '';
          if (!validKeyShape(key)) return json({ ok: false, error: 'API Key 的格式不对，应以 sk- 开头' }, 400);
          if (!(await saveKey(key))) return json({ ok: false, error: '没能存进钥匙串' }, 500);
          console.log('[deepseek] API key saved to the keychain');
          const reading = await refreshBalanceNow();
          publish();
          return json({ ok: true, hasKey: true, state: reading.state });
        });
        return;
      }
      case '/deepseek/recheck':
        refreshBalanceNow().then((reading) => { publish(); json({ ok: true, state: reading.state }); });
        return;
    }
  });

  server.on('error', (error) => {
    // Port already taken by another copy of the watcher: keep watching anyway.
    console.error('state server failed:', error.message);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
