// Usage limits for the menu-bar panel and notch: how much of each window is
// left, when it resets, and recent local token activity.
//
// Codex      every model response in a rollout log carries `rate_limits`, with
//            a 5-hour (primary) and a weekly (secondary) window.
// Claude     strictly local, zero network, zero sign-in borrowing:
//            1) Claude Code CLI status line (`claude-statusline.json`, exact % + reset time)
//            2) Claude Desktop local plan history (`plan-usage-history.json`, fh/sd/xu + trend)
//            3) Local conversation JSONL logs (refusal reset times + recent token usage)
// DeepSeek   billed per token, with no time windows, so it shows account balance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestCodexFiles } from './providers.mjs';
import { readClaudeDesktopIdbQuota } from './claude-desktop-idb.mjs';
import { windowOf } from './window.mjs';
import { readConfig } from './config.mjs';
import { STATUSLINE_FILE } from './statusline.mjs';
import { deepseekBalance } from './deepseek-balance.mjs';

const TAIL_BYTES = 512 * 1024;
const FILES_TO_SEARCH = 6;

const WINDOW_KIND = { 300: 'five_hour', 10080: 'weekly' };

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

export { windowOf } from './window.mjs';

let codexCache = { key: '', value: null };

export function readCodexQuota(now = Date.now()) {
  // No age limit: limits stay meaningful for days after the last use.
  const files = latestCodexFiles(FILES_TO_SEARCH, Infinity);
  const key = files.map((f) => f.file + ':' + f.mtime + ':' + f.size).join('|');
  if (key && key === codexCache.key && codexCache.value) return refresh(codexCache.value, now);

  let found = null;
  for (const { file } of files) {
    let lines;
    try {
      lines = tailLines(file);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(lines[i]);
        const limits = record.payload && record.payload.rate_limits;
        if (!limits) continue;
        const at = Date.parse(record.timestamp) || 0;
        if (!found || at > found.at) found = { at, limits };
        break;
      } catch {
        /* a line cut by the tail window */
      }
    }
  }

  const value = found ? { observedAt: found.at, limits: found.limits } : null;
  codexCache = { key, value };
  return refresh(value, now);
}

function refresh(value, now) {
  if (!value) return { id: 'codex', name: 'Codex', state: 'unknown', windows: [] };
  const windows = ['primary', 'secondary']
    .map((slot) => value.limits[slot])
    .filter(Boolean)
    .map((w) => windowOf(WINDOW_KIND[w.window_minutes] || (w.window_minutes <= 600 ? 'five_hour' : 'weekly'), w.used_percent, w.resets_at, now));
  const credits = value.limits.credits;
  const extraCredits = credits && (credits.has_credits || credits.unlimited) ? { unlimited: Boolean(credits.unlimited), balance: credits.balance ?? null } : null;
  return { id: 'codex', name: 'Codex', state: 'ok', observedAt: value.observedAt, windows, credits: extraCredits };
}

// Numbers Claude Code itself handed to the status line (statusline.mjs): no
// network and no sign-in.
const STATUSLINE_FRESH_MS = 24 * 60 * 60_000;

export function statusLineQuota(now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
  } catch {
    return null;
  }
  const observedAt = Number(raw.observedAt) || 0;
  if (!observedAt || now - observedAt > STATUSLINE_FRESH_MS) return null;
  const limits = raw.rate_limits || {};
  const windows = [];
  if (limits.five_hour) windows.push(windowOf('five_hour', limits.five_hour.used_percentage, limits.five_hour.resets_at, now));
  if (limits.seven_day) windows.push(windowOf('weekly', limits.seven_day.used_percentage, limits.seven_day.resets_at, now));
  return windows.length ? { state: 'ok', source: 'statusline', observedAt, windows, extras: [] } : null;
}

// Claude Desktop writes plan usage samples locally to plan-usage-history.json:
// { version: 2, samples: [{ t: ms, org: uuid, u: { fh?: pct, sd?: pct, xu?: pct } }] }.
const CLAUDE_PLAN_HISTORY_FILE = process.env.FIRE_RING_CLAUDE_PLAN_HISTORY
  || path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');
const DESKTOP_FIVE_HOUR_MAX_AGE_MS = 6 * 60 * 60_000;
const DESKTOP_WEEKLY_MAX_AGE_MS = 8 * 24 * 60 * 60_000;

let desktopPlanCache = { key: '', samples: null };

function loadDesktopSamples() {
  let stat;
  try {
    stat = fs.statSync(CLAUDE_PLAN_HISTORY_FILE);
  } catch {
    desktopPlanCache = { key: '', samples: null };
    return null;
  }
  const key = stat.mtimeMs + ':' + stat.size;
  if (key === desktopPlanCache.key) return desktopPlanCache.samples;
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_PLAN_HISTORY_FILE, 'utf8'));
    const samples = Array.isArray(raw && raw.samples) ? raw.samples : [];
    desktopPlanCache = { key, samples };
    return samples;
  } catch {
    return desktopPlanCache.samples;
  }
}

function estimateWeeklyTrend(samples, latest, now) {
  if (!latest || !Number.isFinite(latest.u?.sd)) return null;
  const org = latest.org || '';
  const windowCutoff = now - 7 * 24 * 60 * 60_000;
  let earliest = latest;
  let prevSd = Number(latest.u.sd);
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i];
    if (!s || !Number.isFinite(s.t) || s.t < windowCutoff) break;
    if ((s.org || '') !== org) continue;
    if (!Number.isFinite(s.u?.sd)) continue;
    const sd = Number(s.u.sd);
    // Usage dropped significantly: crossed a weekly reset boundary.
    if (sd > prevSd) break;
    earliest = s;
    prevSd = sd;
  }
  const elapsedHours = (latest.t - earliest.t) / 3_600_000;
  const delta = Number(latest.u.sd) - Number(earliest.u.sd);
  if (elapsedHours < 0.5 || delta < 2) return null;
  const perHour = delta / elapsedHours;
  const left = Math.max(0, 100 - Number(latest.u.sd));
  return {
    weeklyPerHour: Math.round(perHour * 100) / 100,
    estimatedHoursLeft: left > 0 ? Math.round((left / perHour) * 10) / 10 : 0,
  };
}

/** Reads official plan usage percentages persisted locally by Claude Desktop. */
export function desktopPlanQuota(now = Date.now()) {
  const samples = loadDesktopSamples();
  if (!samples || !samples.length) return null;
  let latest = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s && Number.isFinite(s.t) && s.u && typeof s.u === 'object') {
      latest = s;
      break;
    }
  }
  if (!latest || now - latest.t > DESKTOP_WEEKLY_MAX_AGE_MS) return null;

  const windows = [];
  if (Number.isFinite(latest.u.fh) && now - latest.t <= DESKTOP_FIVE_HOUR_MAX_AGE_MS) {
    windows.push(windowOf('five_hour', latest.u.fh, null, now));
  }
  if (Number.isFinite(latest.u.sd)) {
    windows.push(windowOf('weekly', latest.u.sd, null, now));
  }
  if (!windows.length) return null;

  const extraUsage = Number.isFinite(latest.u.xu)
    ? { usedPercent: Math.max(0, Math.min(100, Number(latest.u.xu))) }
    : null;
  const trend = estimateWeeklyTrend(samples, latest, now);
  return { state: 'ok', source: 'desktop', observedAt: latest.t, windows, extras: [], extraUsage, trend };
}

// Local Claude Code transcripts (~/.claude/projects/*/*.jsonl): used both for
// refusal reset timestamps and lightweight local token activity summaries.
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const LIMIT_FILES = 20;
const LIMIT_MAX_AGE_MS = 8 * 24 * 60 * 60_000;   // a weekly limit can last a week
const LIMIT_KIND = { five_hour: 'five_hour', seven_day: 'weekly', weekly: 'weekly' };

function recentClaudeFiles(now, maxAge = LIMIT_MAX_AGE_MS, limit = LIMIT_FILES) {
  const files = [];
  let projects = [];
  try {
    projects = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return files;
  }
  for (const project of projects) {
    const dir = path.join(CLAUDE_PROJECTS, project);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (now - stat.mtimeMs < maxAge) files.push({ file: path.join(dir, name), mtime: stat.mtimeMs, size: stat.size });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

let limitCache = { key: '', value: [] };

/** Limits Claude Code reported as used up and not yet reset: [{ kind, resetsAt (s) }]. */
export function usedUpClaudeLimits(now = Date.now()) {
  const files = recentClaudeFiles(now);
  const key = files.map((f) => f.file + ':' + f.mtime).join('|');
  if (key !== limitCache.key) {
    // A refusal only counts while nothing has worked since: one real reply from
    // Claude after it, in any conversation, shows the limit is usable again.
    const found = new Map();   // kind -> { resetsAt, at }
    let lastReplyAt = 0;
    for (const { file } of files) {
      let lines;
      try {
        lines = tailLines(file);
      } catch {
        continue;
      }
      for (const line of lines) {
        const refusal = line.includes('"rate_limit_info"');
        if (!refusal && !line.includes('"type":"assistant"')) continue;
        try {
          const record = JSON.parse(line);
          const at = Date.parse(record.timestamp) || 0;
          if (record.type === 'assistant' && !record.isApiErrorMessage) {
            if (at > lastReplyAt) lastReplyAt = at;
            continue;
          }
          const info = record.apiErrorParams && record.apiErrorParams.rate_limit_info;
          if (!info || info.status !== 'rejected' || !Number(info.resetsAt)) continue;
          const kind = LIMIT_KIND[info.rateLimitType] || 'scoped';
          const known = found.get(kind);
          if (!known || at > known.at) found.set(kind, { resetsAt: Number(info.resetsAt), at });
        } catch {
          /* a line cut by the tail window */
        }
      }
    }
    limitCache = {
      key,
      value: [...found].filter(([, r]) => r.at > lastReplyAt).map(([kind, r]) => ({ kind, resetsAt: r.resetsAt })),
    };
  }
  return limitCache.value.filter((l) => l.resetsAt * 1000 > now);
}

const USAGE_FILE_CACHE = new Map(); // file -> { mtime, size, entries: [{ at, model, tokens }] }
const DAY_MS = 24 * 60 * 60_000;
const FIVE_HOUR_MS = 5 * 60 * 60_000;

function parseUsageEntries(file) {
  const entries = [];
  let lines;
  try {
    lines = tailLines(file);
  } catch {
    return entries;
  }
  for (const line of lines) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== 'assistant' || record.isApiErrorMessage) continue;
      const usage = record.message && record.message.usage;
      if (!usage || typeof usage !== 'object') continue;
      const at = Date.parse(record.timestamp) || 0;
      if (!at) continue;
      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
      entries.push({
        at,
        model: typeof record.message.model === 'string' ? record.message.model : '',
        tokens: input + output + cacheRead + cacheWrite,
        billable: input + output + cacheWrite,
      });
    } catch {
      /* partial line from tail */
    }
  }
  return entries;
}

/** Local token activity from Claude Code transcripts (last 5h & today). */
export function localClaudeUsage(now = Date.now()) {
  const files = recentClaudeFiles(now, DAY_MS, 16);
  const fiveHourCutoff = now - FIVE_HOUR_MS;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const fiveHour = { messages: 0, totalTokens: 0, activeTokens: 0 };
  const today = { messages: 0, totalTokens: 0, activeTokens: 0 };
  let latestModel = '';
  let latestAt = 0;

  for (const { file, mtime, size } of files) {
    let hit = USAGE_FILE_CACHE.get(file);
    if (!hit || hit.mtime !== mtime || hit.size !== size) {
      hit = { mtime, size, entries: parseUsageEntries(file) };
      USAGE_FILE_CACHE.set(file, hit);
    }
    for (const e of hit.entries) {
      if (e.at >= fiveHourCutoff) {
        fiveHour.messages += 1;
        fiveHour.totalTokens += e.tokens;
        fiveHour.activeTokens += e.billable;
      }
      if (e.at >= midnight) {
        today.messages += 1;
        today.totalTokens += e.tokens;
        today.activeTokens += e.billable;
      }
      if (e.model && e.at > latestAt) {
        latestAt = e.at;
        latestModel = e.model;
      }
    }
  }

  if (!fiveHour.messages && !today.messages) return null;
  return { fiveHour, today, model: latestModel || null };
}

function mergeWindows(primary, secondary, usedUp, now) {
  const byKind = new Map();
  for (const w of secondary || []) byKind.set(w.kind, { ...w });
  for (const w of primary || []) {
    const fallback = byKind.get(w.kind);
    byKind.set(w.kind, {
      ...w,
      resetsAt: w.resetsAt ?? fallback?.resetsAt ?? null,
    });
  }
  for (const l of usedUp || []) {
    byKind.set(l.kind, windowOf(l.kind, 100, l.resetsAt, now));
  }
  const order = { five_hour: 0, weekly: 1, scoped: 2 };
  return [...byKind.values()].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
}

/**
 * Claude's limits, read strictly on this Mac:
 * 1) Claude Code status line (`claude-statusline.json`, exact percentages + reset times)
 * 2) Claude Desktop live local IndexedDB verdicts (`messageLimits`, real-time % + reset time)
 * 3) Claude Desktop local history (`plan-usage-history.json`, periodic percentages + trend)
 * 4) Local conversation refusal notes & token activity.
 * Fire Ring never borrows Claude sign-in credentials or queries Anthropic over the network.
 */
export function readClaudeQuota(now = Date.now()) {
  const local = statusLineQuota(now);
  const desktopIdb = readClaudeDesktopIdbQuota(now);
  const desktopHist = desktopPlanQuota(now);
  const usedUp = usedUpClaudeLimits(now);
  const localUsage = localClaudeUsage(now);

  let desktop = null;
  if (desktopIdb && desktopHist) {
    const idbNewer = desktopIdb.observedAt >= desktopHist.observedAt;
    const windows = idbNewer
      ? mergeWindows(desktopIdb.windows, desktopHist.windows, null, now)
      : mergeWindows(desktopHist.windows, desktopIdb.windows, null, now);
    const week = windows.find((w) => w.kind === 'weekly');
    let trend = desktopHist.trend || null;
    if (trend && week && Number.isFinite(trend.weeklyPerHour) && trend.weeklyPerHour > 0) {
      trend = {
        weeklyPerHour: trend.weeklyPerHour,
        estimatedHoursLeft: week.leftPercent > 0 ? Math.round((week.leftPercent / trend.weeklyPerHour) * 10) / 10 : 0,
      };
    }
    desktop = {
      state: 'ok',
      source: 'desktop',
      observedAt: Math.max(desktopIdb.observedAt, desktopHist.observedAt),
      windows,
      extras: desktopIdb.extras || [],
      extraUsage: desktopHist.extraUsage || null,
      trend,
    };
  } else {
    desktop = desktopIdb || desktopHist;
  }

  if (local && desktop) {
    // Prefer whichever source observed usage more recently (with 60s hysteresis in favour of statusline).
    const desktopNewer = desktop.observedAt > local.observedAt + 60_000;
    const windows = desktopNewer
      ? mergeWindows(desktop.windows, local.windows, usedUp, now)
      : mergeWindows(local.windows, desktop.windows, usedUp, now);
    return {
      id: 'claude',
      name: 'Claude',
      state: 'ok',
      source: desktopNewer ? 'merged' : 'statusline',
      observedAt: Math.max(local.observedAt, desktop.observedAt),
      windows,
      extras: desktop.extras || [],
      extraUsage: desktop.extraUsage || null,
      trend: desktop.trend || null,
      localUsage,
    };
  }
  if (local) {
    const windows = mergeWindows(local.windows, null, usedUp, now);
    return { id: 'claude', name: 'Claude', ...local, windows, localUsage };
  }
  if (desktop) {
    const windows = mergeWindows(desktop.windows, null, usedUp, now);
    return { id: 'claude', name: 'Claude', ...desktop, windows, localUsage };
  }
  if (usedUp.length) {
    const windows = usedUp.map((l) => windowOf(l.kind, 100, l.resetsAt, now));
    return { id: 'claude', name: 'Claude', state: 'ok', source: 'limit', observedAt: now, windows, extras: [], localUsage };
  }
  return { id: 'claude', name: 'Claude', state: 'limits_only', source: 'limit', windows: [], localUsage };
}

/** Platforms with a window used up right now; their sessions cannot be running. */
export function exhaustedProviders(now = Date.now()) {
  const out = new Set();
  // Every connected tool counts here, whether or not its limits are shown.
  for (const q of connectedQuota(now)) {
    if (q.state === 'ok' && q.windows.some((w) => !w.reset && w.leftPercent <= 0)) out.add(q.id);
  }
  return out;
}

/** DeepSeek is billed per token: its account balance, not time windows. */
export function readDeepSeekQuota(now = Date.now()) {
  return { id: 'dsh', name: 'DeepSeek', kind: 'balance', windows: [], ...deepseekBalance(now) };
}

/** Limits of every connected tool, for Fire Ring's own use. */
export function connectedQuota(now = Date.now()) {
  const { providers } = readConfig();
  return [
    providers.claude ? readClaudeQuota(now) : null,
    providers.codex ? readCodexQuota(now) : null,
  ].filter(Boolean);
}

/** The limits the menu-bar panel shows: connected tools the user chose to see. */
export function readQuota(now = Date.now()) {
  const { quota, providers } = readConfig();
  const shown = connectedQuota(now).filter((q) => quota[q.id] === true);
  // The balance is asked over the network only while it is shown.
  if (providers.dsh && quota.dsh) shown.push(readDeepSeekQuota(now));
  return shown;
}

/** Compact quota snapshot for the notch expanded card (no network triggers). */
export function quotaSummary(now = Date.now()) {
  const { quota, providers } = readConfig();
  const out = [];
  for (const q of connectedQuota(now)) {
    if (quota[q.id] !== true || q.state !== 'ok' || !q.windows.length) continue;
    out.push({
      id: q.id,
      name: q.name,
      windows: q.windows.map((w) => ({ kind: w.kind, leftPercent: Math.round(w.leftPercent), reset: Boolean(w.reset) })),
    });
  }
  if (providers.dsh && quota.dsh) {
    const ds = readDeepSeekQuota(now);
    const main = Array.isArray(ds.balances) ? ds.balances[0] : null;
    if (main && Number.isFinite(Number(main.total))) {
      out.push({ id: 'dsh', name: 'DeepSeek', currency: main.currency, total: Number(main.total) });
    }
  }
  return out;
}
