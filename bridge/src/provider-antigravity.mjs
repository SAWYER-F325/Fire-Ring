// Antigravity sessions, read strictly from its local SQLite summary database
// (~/.gemini/antigravity/conversation_summaries.db) and transcript tails for
// "waiting on you" detection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { windowOf } from './window.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* older Node without node:sqlite */
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;
const MAX_ROWS = 32;
const TAIL_BYTES = 48 * 1024;
const ANTIGRAVITY_BUNDLE = 'com.google.antigravity';

const agyHome = () => process.env.FIRE_RING_ANTIGRAVITY_HOME
  || path.join(os.homedir(), '.gemini', 'antigravity');

const transcriptCache = new Map(); // file -> { mtime, size, waiting }

function parseWorkspace(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let first = '';
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) first = String(arr[0] || '');
  } catch {
    first = raw;
  }
  if (!first) return '';
  if (first.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(first).pathname);
    } catch {
      return first.replace(/^file:\/\//, '');
    }
  }
  return first;
}

function readWaitingFromTranscript(root, id) {
  const file = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const hit = transcriptCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.waiting;

  let waiting = false;
  try {
    const length = Math.min(stat.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, 'r');
    try {
      fs.readSync(handle, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(handle);
    }
    const lines = buffer.toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === 'USER_INPUT') {
        waiting = false;
        continue;
      }
      // Unanswered ask_question / RequestFeedback marks the conversation as waiting on user.
      const text = JSON.stringify(rec);
      if (text.includes('"ask_question"') || text.includes('"RequestFeedback":true')) {
        waiting = true;
      } else if (rec.type === 'PLANNER_RESPONSE' && rec.status === 'DONE') {
        waiting = false;
      }
    }
  } catch {
    waiting = false;
  }
  transcriptCache.set(file, { mtime: stat.mtimeMs, size: stat.size, waiting });
  return waiting;
}

export function readAntigravitySessions(now = Date.now()) {
  if (!DatabaseSync) return [];
  const root = agyHome();
  const dbPath = path.join(root, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];

  let rows = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    rows = db.prepare(`
      SELECT conversation_id, title, status, source, workspace_uris,
             not_fully_idle, killed, nesting_depth, parent_conversation_id,
             last_modified_time
      FROM conversation_summaries
      WHERE nesting_depth = 0
        AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)
      ORDER BY last_modified_time DESC
      LIMIT ?
    `).all(MAX_ROWS);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  const out = [];
  for (const row of rows) {
    const id = String(row.conversation_id || '');
    if (!id) continue;
    const updatedAt = Date.parse(row.last_modified_time) || 0;
    if (!updatedAt || now - updatedAt > MAX_AGE_MS) continue;
    const rawTitle = String(row.title || '').trim();
    const source = String(row.source || '');
    // Skip untitled headless CLI sub-invocations (e.g. `agy -p` called by another agent).
    if (source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && !rawTitle) continue;

    const cwd = parseWorkspace(row.workspace_uris);
    const killed = Boolean(row.killed);
    const active = !killed && (row.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(row.not_fully_idle));
    const stale = active && now - updatedAt >= STALE_MS;
    const waiting = !killed && readWaitingFromTranscript(root, id);
    const running = active && !stale && !waiting;

    out.push({
      id,
      provider: 'antigravity',
      providerName: 'Antigravity',
      title: rawTitle || (cwd ? path.basename(cwd) : 'Antigravity 会话'),
      project: cwd,
      cwd,
      running,
      waiting,
      quietEnd: killed || stale,
      stale,
      updatedAt,
      open: { kind: 'app', value: ANTIGRAVITY_BUNDLE },
    });
  }
  return out;
}

const USAGE_CACHE = new Map();
const FIVE_HOUR_MS = 5 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

function readAntigravitySnapshot(now) {
  const file = path.join(DATA_DIR, 'antigravity-quota.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const observedAt = Number(raw.observedAt || (raw.fetched_at ? raw.fetched_at * 1000 : 0)) || 0;
  if (!observedAt || now - observedAt > SNAPSHOT_MAX_AGE_MS) return null;
  const windows = [];
  if (raw.five_hour && Number.isFinite(raw.five_hour.used_percentage)) {
    windows.push(windowOf('five_hour', raw.five_hour.used_percentage, raw.five_hour.resets_at, now));
  }
  if (raw.seven_day && Number.isFinite(raw.seven_day.used_percentage)) {
    windows.push(windowOf('weekly', raw.seven_day.used_percentage, raw.seven_day.resets_at, now));
  }
  const plan = raw.plan || raw.metadata?.['antigravity.plan'] || null;
  return windows.length ? { observedAt, windows, plan } : null;
}

function parseTranscriptUsage(file) {
  const entries = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return entries;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('PLANNER_RESPONSE') || !line.includes('output_tokens')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== 'PLANNER_RESPONSE') continue;
      const at = Date.parse(rec.created_at) || 0;
      if (!at) continue;
      const input = Number(rec.input_tokens) || 0;
      const cacheRead = Number(rec.cache_read_tokens) || 0;
      const output = Number(rec.output_tokens) || 0;
      entries.push({ at, model: typeof rec.model === 'string' ? rec.model : '', total: input + cacheRead + output, active: input + output });
    } catch { /* skip malformed */ }
  }
  return entries;
}

/** Reads Antigravity real-time local token usage and optional local quota snapshot. */
export function readAntigravityQuota(now = Date.now()) {
  const snap = readAntigravitySnapshot(now);
  const brainDir = path.join(agyHome(), 'brain');
  const fiveHourCutoff = now - FIVE_HOUR_MS;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const fiveHour = { messages: 0, totalTokens: 0, activeTokens: 0 };
  const today = { messages: 0, totalTokens: 0, activeTokens: 0 };
  let latestAt = 0;
  let latestModel = '';

  let dirs = [];
  try {
    dirs = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch { /* ignore */ }

  const files = [];
  for (const e of dirs) {
    if (!e.isDirectory()) continue;
    const f = path.join(brainDir, e.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = fs.statSync(f);
      if (now - st.mtimeMs <= DAY_MS) files.push({ file: f, mtime: st.mtimeMs, size: st.size });
    } catch { /* ignore */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { file, mtime, size } of files.slice(0, 20)) {
    let hit = USAGE_CACHE.get(file);
    if (!hit || hit.mtime !== mtime || hit.size !== size) {
      hit = { mtime, size, entries: parseTranscriptUsage(file) };
      USAGE_CACHE.set(file, hit);
    }
    for (const item of hit.entries) {
      if (item.at >= fiveHourCutoff) {
        fiveHour.messages += 1;
        fiveHour.totalTokens += item.total;
        fiveHour.activeTokens += item.active;
      }
      if (item.at >= midnight) {
        today.messages += 1;
        today.totalTokens += item.total;
        today.activeTokens += item.active;
      }
      if (item.at > latestAt) {
        latestAt = item.at;
        if (item.model) latestModel = item.model;
      }
    }
  }

  const localUsage = (fiveHour.messages || today.messages) ? { fiveHour, today, model: latestModel || null } : null;
  const windows = snap ? snap.windows : [];
  const observedAt = Math.max(snap?.observedAt || 0, latestAt) || null;
  const hasAny = windows.length > 0 || Boolean(localUsage);

  return {
    id: 'antigravity',
    name: 'Antigravity',
    kind: windows.length ? 'windows' : 'usage',
    state: hasAny ? 'ok' : 'unknown',
    source: windows.length ? 'snapshot' : 'local',
    observedAt,
    plan: snap?.plan || null,
    windows,
    extras: [],
    localUsage,
  };
}
