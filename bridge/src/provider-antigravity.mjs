// Antigravity sessions, read strictly from its local SQLite summary database
// (~/.gemini/antigravity/conversation_summaries.db) and transcript tails for
// "waiting on you" detection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
