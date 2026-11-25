// Usage limits for the menu-bar panel: how much of each window is left and
// when it resets.
//
// Codex      every model response in a rollout log carries `rate_limits`, with
//            a 5-hour (primary) and a weekly (secondary) window.
// Claude     only what Claude Code leaves on this Mac: its status line (terminal
//            sessions) or the "used up until …" notes in its conversations.
// DeepSeek   billed per token, with no time windows, so it is left out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestCodexFiles } from './providers.mjs';
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
// network and no sign-in. Within a day they are preferred to asking Anthropic.
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

// When a limit is used up, Claude Code records the refusal in the conversation
// with which window it was and when it resets. That is all the desktop app
// leaves behind; there are no running percentages.
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const LIMIT_FILES = 20;
const LIMIT_MAX_AGE_MS = 8 * 24 * 60 * 60_000;   // a weekly limit can last a week
const LIMIT_KIND = { five_hour: 'five_hour', seven_day: 'weekly', weekly: 'weekly' };

function recentClaudeFiles(now) {
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
        if (now - stat.mtimeMs < LIMIT_MAX_AGE_MS) files.push({ file: path.join(dir, name), mtime: stat.mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT_FILES);
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

/**
 * Claude's limits, read on this Mac only: Claude Code's status line if it runs
 * (terminal sessions), else the "used up until …" notes Claude Code leaves in
 * its conversations. Fire Ring no longer asks Anthropic with the Claude Code
 * sign-in: Anthropic revoked that sign-in each time it was used this way.
 */
export function readClaudeQuota(now = Date.now()) {
  const local = statusLineQuota(now);
  if (local) return { id: 'claude', name: 'Claude', ...local };
  const usedUp = usedUpClaudeLimits(now);
  if (usedUp.length) {
    const windows = usedUp.map((l) => windowOf(l.kind, 100, l.resetsAt, now));
    return { id: 'claude', name: 'Claude', state: 'ok', source: 'limit', observedAt: now, windows, extras: [] };
  }
  return { id: 'claude', name: 'Claude', state: 'limits_only', source: 'limit', windows: [] };
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
