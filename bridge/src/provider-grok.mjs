// Grok sessions: supports both Grok CLI (~/.grok/sessions/ + hooks) and
// Grok Desktop (~/Library/Application Support/com.grokapp.grok-app/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;
const MAX_SESSIONS = 24;
const TAIL_BYTES = 128 * 1024;
const GROK_DESKTOP_BUNDLE = 'com.grokapp.desktop';

const grokHome = () => process.env.FIRE_RING_GROK_HOME || path.join(os.homedir(), '.grok');
const grokDesktopHome = () => process.env.FIRE_RING_GROK_DESKTOP_HOME
  || path.join(os.homedir(), 'Library', 'Application Support', 'com.grokapp.grok-app');

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

const cliCache = new Map();
const desktopCache = new Map();
const liveHooks = new Map();

function tailLines(file) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(handle);
  }
  return buffer.toString('utf8').split('\n');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Records a live event relayed from ~/.grok/hooks/fire-ring.json. */
export function recordGrokHook(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return false;
  const id = String(payload.session_id || payload.sessionId || '').trim();
  if (!id) return false;
  const event = String(payload.hook_event_name || payload.event_name || payload.event || '').trim();
  const prev = liveHooks.get(id) || { id, cwd: '', title: '', running: false, waiting: false, quietEnd: false, updatedAt: now };
  const cwd = String(payload.cwd || prev.cwd || '');
  let { running, waiting, quietEnd } = prev;

  if (['UserPromptSubmit', 'user_prompt_submit', 'PreToolUse', 'pre_tool_use', 'PostToolUse', 'post_tool_use', 'PostToolUseFailure', 'post_tool_use_failure'].includes(event)) {
    running = true; waiting = false; quietEnd = false;
  } else if (event === 'PermissionRequest' || event === 'permission_request' || (event === 'Notification' && /permission|approv|wait|confirm|question/i.test(String(payload.message || payload.notification_type || '')))) {
    running = false; waiting = true; quietEnd = false;
  } else if (['Stop', 'stop', 'SessionEnd', 'session_end'].includes(event)) {
    running = false; waiting = false; quietEnd = false;
  }

  liveHooks.set(id, { id, cwd, title: prev.title, running, waiting, quietEnd, updatedAt: now });
  return true;
}

export function clearGrokHooksForTest() {
  liveHooks.clear();
  cliCache.clear();
  desktopCache.clear();
}

function parseGrokCliDir(dir, now) {
  const summaryFile = path.join(dir, 'summary.json');
  const updatesFile = path.join(dir, 'updates.jsonl');
  let stat;
  try {
    stat = fs.existsSync(updatesFile) ? fs.statSync(updatesFile) : fs.statSync(summaryFile);
  } catch {
    return null;
  }
  if (now - stat.mtimeMs > MAX_AGE_MS) return null;

  const key = dir;
  const hit = cliCache.get(key);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
    const stale = hit.session.running && now - hit.mtime >= STALE_MS;
    return { ...hit.session, running: hit.session.running && !stale, quietEnd: hit.session.quietEnd || stale, stale };
  }

  const summary = readJson(summaryFile);
  const id = String(summary?.info?.id || path.basename(dir));
  const cwd = String(summary?.info?.cwd || '');
  const title = String(summary?.session_summary || '').trim();
  if (title.startsWith('为下面这条用户消息起一个简短会话标题')) return null;

  let turn = 'closed'; // open | closed | interrupted
  let waiting = false;
  let updatedAt = Date.parse(summary?.updated_at || '') || stat.mtimeMs;

  if (fs.existsSync(updatesFile)) {
    for (const line of tailLines(updatesFile)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (Number.isFinite(rec.timestamp)) {
        const ms = rec.timestamp > 1e12 ? rec.timestamp : rec.timestamp * 1000;
        if (ms > updatedAt) updatedAt = ms;
      }
      const upd = rec.params && rec.params.update;
      if (!upd || typeof upd !== 'object') continue;
      const kind = upd.sessionUpdate;
      if (['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'task_backgrounded'].includes(kind)) {
        turn = 'open';
        waiting = false;
      } else if (kind === 'permission_request' || kind === 'user_input_request') {
        waiting = true;
      } else if (kind === 'turn_completed') {
        waiting = false;
        turn = upd.stop_reason === 'cancelled' ? 'interrupted' : 'closed';
      } else if (kind === 'hook_execution' && (upd.event_name === 'stop' || upd.event_name === 'session_end')) {
        waiting = false;
        if (turn === 'open') turn = 'closed';
      }
    }
  }

  const running = turn === 'open' && !waiting;
  const stale = running && now - stat.mtimeMs >= STALE_MS;
  const session = {
    id,
    provider: 'grok',
    providerName: 'Grok',
    title: title || (cwd ? path.basename(cwd) : 'Grok 会话'),
    project: cwd,
    cwd,
    running: running && !stale,
    waiting,
    quietEnd: turn === 'interrupted' || stale,
    stale,
    updatedAt: Math.max(updatedAt, stat.mtimeMs),
    open: cwd
      ? { kind: 'terminal', value: `cd ${shellQuote(cwd)} && grok --resume ${shellQuote(id)}` }
      : { kind: 'terminal', value: `grok --resume ${shellQuote(id)}` },
  };
  cliCache.set(key, { mtime: stat.mtimeMs, size: stat.size, session });
  return session;
}

function readGrokCliSessions(now) {
  const root = path.join(grokHome(), 'sessions');
  let buckets = [];
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const b of buckets) {
    if (!b.isDirectory()) continue;
    const bPath = path.join(root, b.name);
    let dirs = [];
    try {
      dirs = fs.readdirSync(bPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const full = path.join(bPath, d.name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs <= MAX_AGE_MS) candidates.push({ dir: full, mtime: stat.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { dir } of candidates.slice(0, MAX_SESSIONS)) {
    const s = parseGrokCliDir(dir, now);
    if (s) out.push(s);
  }
  return out;
}

function readGrokDesktopSessions(now) {
  const root = grokDesktopHome();
  const index = readJson(path.join(root, 'sessions_index.json'));
  if (!Array.isArray(index)) return [];

  const out = [];
  for (const entry of index) {
    if (!entry || entry.archived) continue;
    const id = String(entry.id || '');
    if (!id) continue;
    let updatedAt = Date.parse(entry.updatedAt || '') || 0;
    const msgFile = path.join(root, 'sessions', id, 'messages.json');
    let msgStat = null;
    try {
      msgStat = fs.statSync(msgFile);
      if (msgStat.mtimeMs > updatedAt) updatedAt = msgStat.mtimeMs;
    } catch { /* ignore */ }
    if (!updatedAt || now - updatedAt > MAX_AGE_MS) continue;

    let running = false;
    let quietEnd = false;
    if (msgStat) {
      const hit = desktopCache.get(msgFile);
      if (hit && hit.mtime === msgStat.mtimeMs && hit.size === msgStat.size) {
        running = hit.running;
        quietEnd = hit.quietEnd;
      } else {
        const msgs = readJson(msgFile);
        if (Array.isArray(msgs) && msgs.length) {
          const last = msgs[msgs.length - 1];
          if (last && last.marker === 'turn_cancelled') quietEnd = true;
          else if (last && last.role === 'user') running = true;
        }
        desktopCache.set(msgFile, { mtime: msgStat.mtimeMs, size: msgStat.size, running, quietEnd });
      }
    }
    const stale = running && now - updatedAt >= STALE_MS;
    out.push({
      id,
      agentSessionId: entry.agentSessionId ? String(entry.agentSessionId) : null,
      provider: 'grok',
      providerName: 'Grok',
      title: String(entry.title || '').trim() || 'Grok 会话',
      project: '',
      cwd: '',
      running: running && !stale,
      waiting: false,
      quietEnd: quietEnd || stale,
      stale,
      updatedAt,
      open: { kind: 'app', value: GROK_DESKTOP_BUNDLE },
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
}

export function readGrokSessions(now = Date.now()) {
  const byId = new Map();
  for (const s of readGrokCliSessions(now)) byId.set(s.id, s);

  // Merge Desktop sessions: if linked to a CLI agentSessionId, upgrade open target to Grok Desktop.
  for (const ds of readGrokDesktopSessions(now)) {
    const cli = ds.agentSessionId ? byId.get(ds.agentSessionId) : null;
    if (cli) {
      byId.set(cli.id, {
        ...cli,
        title: ds.title || cli.title,
        running: cli.running || ds.running,
        updatedAt: Math.max(cli.updatedAt, ds.updatedAt),
        open: ds.open,
      });
    } else {
      const { agentSessionId, ...rest } = ds;
      byId.set(rest.id, rest);
    }
  }

  for (const [id, h] of liveHooks) {
    if (now - h.updatedAt > MAX_AGE_MS) {
      liveHooks.delete(id);
      continue;
    }
    const base = byId.get(id);
    const stale = h.running && now - h.updatedAt >= STALE_MS;
    if (base && base.updatedAt > h.updatedAt + 1000) continue;
    const cwd = h.cwd || base?.cwd || '';
    byId.set(id, {
      id,
      provider: 'grok',
      providerName: 'Grok',
      title: base?.title || h.title || (cwd ? path.basename(cwd) : 'Grok 会话'),
      project: cwd || base?.project || '',
      cwd,
      running: h.running && !stale,
      waiting: h.waiting,
      quietEnd: h.quietEnd || stale,
      stale,
      updatedAt: Math.max(h.updatedAt, base?.updatedAt || 0),
      open: base?.open || (cwd
        ? { kind: 'terminal', value: `cd ${shellQuote(cwd)} && grok --resume ${shellQuote(id)}` }
        : { kind: 'app', value: GROK_DESKTOP_BUNDLE }),
    });
  }

  return [...byId.values()];
}
