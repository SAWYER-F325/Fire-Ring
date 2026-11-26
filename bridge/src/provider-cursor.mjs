// Cursor agent sessions: real-time lifecycle hooks (via POST /hook?provider=cursor)
// combined with local agent transcript logs (~/.cursor/projects/*/agent-transcripts/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { windowOf } from './window.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* older Node */ }

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;
const MAX_FILES = 24;
const CURSOR_BUNDLE = 'com.todesktop.230313mzl4w4u92';

const cursorHome = () => process.env.FIRE_RING_CURSOR_HOME || path.join(os.homedir(), '.cursor');
const liveHooks = new Map();   // conversation_id -> { id, title, cwd, running, waiting, quietEnd, updatedAt }
const transcriptCache = new Map();

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const query = raw.match(/<user_query>\s*([\s\S]*?)(?:<\/user_query>|$)/i);
  const text = (query ? query[1] : raw)
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, ' ')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, ' ')
    .replace(/\[Image\]/gi, ' ')
    .replace(/[#*`>\-]+\s?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 60);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
    .join(' ');
}

function openTarget(cwd) {
  if (cwd && fs.existsSync(cwd)) {
    return { kind: 'url', value: 'cursor://file' + encodeURI(cwd) };
  }
  return { kind: 'app', value: CURSOR_BUNDLE };
}

/** Records a live event relayed from ~/.cursor/hooks.json. */
export function recordCursorHook(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return false;
  const id = String(payload.conversation_id || payload.session_id || payload.generation_id || '').trim();
  if (!id) return false;
  const event = String(payload.hook_event_name || payload.event || '').trim();
  const prev = liveHooks.get(id) || { id, title: '', cwd: '', running: false, waiting: false, quietEnd: false, updatedAt: now };
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const cwd = String(roots[0] || payload.cwd || prev.cwd || '');
  const promptTitle = cleanTitle(payload.prompt || payload.user_prompt || '');
  const title = prev.title || promptTitle || (cwd ? path.basename(cwd) : 'Cursor 会话');

  let { running, waiting, quietEnd } = prev;
  if (event === 'beforeSubmitPrompt') {
    running = true; waiting = false; quietEnd = false;
  } else if (['afterAgentThought', 'beforeReadFile', 'afterFileEdit', 'afterShellExecution', 'afterMCPExecution', 'subagentStart', 'subagentStop'].includes(event)) {
    running = true; waiting = false; quietEnd = false;
  } else if (event === 'beforeShellExecution' || event === 'beforeMCPExecution') {
    waiting = Boolean(payload.requires_approval || payload.needs_approval);
    running = !waiting;
    quietEnd = false;
  } else if (event === 'afterAgentResponse' || event === 'stop') {
    running = false; waiting = false;
    const st = String(payload.status || '').toLowerCase();
    quietEnd = st === 'aborted' || st === 'cancelled' || st === 'error';
  }

  liveHooks.set(id, { id, title, cwd, running, waiting, quietEnd, updatedAt: now });
  return true;
}

export function clearCursorHooksForTest() {
  liveHooks.clear();
  transcriptCache.clear();
}

function recentTranscripts(root, now) {
  const projectsDir = path.join(root, 'projects');
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const tDir = path.join(projectsDir, proj.name, 'agent-transcripts');
    let entries = [];
    try {
      entries = fs.readdirSync(tDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const candidate = e.isDirectory()
        ? path.join(tDir, e.name, e.name + '.jsonl')
        : e.name.endsWith('.jsonl') ? path.join(tDir, e.name) : '';
      if (!candidate) continue;
      try {
        const stat = fs.statSync(candidate);
        if (now - stat.mtimeMs > MAX_AGE_MS) continue;
        files.push({ file: candidate, projectSlug: proj.name, mtime: stat.mtimeMs, size: stat.size });
      } catch {
        /* missing or rotated */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function parseTranscript(file, projectSlug, mtime, now) {
  const id = path.basename(file, '.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;

  let title = '';
  let lastRole = '';
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.role) lastRole = rec.role;
    if (!title && rec.role === 'user') {
      title = cleanTitle(textOf(rec.message?.content ?? rec.content));
    }
  }
  const active = lastRole === 'user' && now - mtime < STALE_MS;
  const projectLabel = projectSlug === 'empty-window' ? '' : projectSlug;
  return {
    id,
    provider: 'cursor',
    providerName: 'Cursor',
    title: title || projectLabel || 'Cursor 会话',
    project: projectLabel,
    cwd: '',
    running: active,
    waiting: false,
    quietEnd: false,
    updatedAt: mtime,
    open: { kind: 'app', value: CURSOR_BUNDLE },
  };
}

export function readCursorSessions(now = Date.now()) {
  const byId = new Map();
  for (const { file, projectSlug, mtime, size } of recentTranscripts(cursorHome(), now)) {
    const hit = transcriptCache.get(file);
    let session;
    if (hit && hit.mtime === mtime && hit.size === size) {
      session = { ...hit.session };
    } else {
      try {
        session = parseTranscript(file, projectSlug, mtime, now);
      } catch {
        session = null;
      }
      transcriptCache.set(file, { mtime, size, session });
    }
    if (session) byId.set(session.id, session);
  }

  for (const [id, h] of liveHooks) {
    if (now - h.updatedAt > MAX_AGE_MS) {
      liveHooks.delete(id);
      continue;
    }
    const stale = h.running && now - h.updatedAt >= STALE_MS;
    const base = byId.get(id);
    const cwd = h.cwd || base?.cwd || '';
    const title = h.title || base?.title || (cwd ? path.basename(cwd) : 'Cursor 会话');
    byId.set(id, {
      id,
      provider: 'cursor',
      providerName: 'Cursor',
      title,
      project: cwd || base?.project || '',
      cwd,
      running: h.running && !stale,
      waiting: h.waiting,
      quietEnd: h.quietEnd || stale,
      stale,
      updatedAt: Math.max(h.updatedAt, base?.updatedAt || 0),
      open: openTarget(cwd),
    });
  }

  return [...byId.values()];
}

const cursorStorageDb = () => process.env.FIRE_RING_CURSOR_STORAGE_DB
  || path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
let cursorPlanCache = { key: '', value: null };

function readCursorMembership() {
  if (!DatabaseSync) return null;
  const dbPath = cursorStorageDb();
  let st;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return null;
  }
  const key = st.mtimeMs + ':' + st.size;
  if (key === cursorPlanCache.key) return cursorPlanCache.value;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/stripeMembershipType', 'cursorAuth/stripeSubscriptionStatus')`).all();
    const map = Object.fromEntries(rows.map((r) => [r.key, String(r.value || '').trim()]));
    const value = {
      plan: map['cursorAuth/stripeMembershipType'] || null,
      subscriptionStatus: map['cursorAuth/stripeSubscriptionStatus'] || null,
    };
    cursorPlanCache = { key, value };
    return value;
  } catch {
    return cursorPlanCache.value;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function readCursorSnapshot(now) {
  const file = path.join(DATA_DIR, 'cursor-quota.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const observedAt = Number(raw.observedAt || (raw.fetched_at ? raw.fetched_at * 1000 : 0)) || 0;
  if (!observedAt || now - observedAt > 7 * 24 * 60 * 60_000) return null;
  const windows = [];
  if (Array.isArray(raw.windows)) {
    for (const w of raw.windows) {
      if (!w || w.is_enabled === false || !Number.isFinite(w.utilization)) continue;
      const kind = w.kind === 'monthly' ? 'monthly' : w.kind === 'five_hour' ? 'five_hour' : 'weekly';
      if (w.slot === 'primary' || windows.length === 0) {
        windows.push(windowOf(kind, w.utilization, w.resets_at, now));
      }
    }
  } else if (raw.monthly && Number.isFinite(raw.monthly.used_percentage)) {
    windows.push(windowOf('monthly', raw.monthly.used_percentage, raw.monthly.resets_at, now));
  }
  return windows.length ? { observedAt, windows, plan: raw.metadata?.['cursor.membershipType'] || raw.plan || null } : null;
}

/** Reads Cursor local membership tier, active sessions/turns, and optional local quota snapshot. */
export function readCursorQuota(now = Date.now()) {
  const snap = readCursorSnapshot(now);
  const membership = readCursorMembership();
  const sessions = readCursorSessions(now);
  const fiveHourCutoff = now - 5 * 60 * 60_000;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const fiveHourSessions = sessions.filter((s) => s.updatedAt >= fiveHourCutoff).length;
  const todaySessions = sessions.filter((s) => s.updatedAt >= midnight).length;
  const latestAt = sessions.reduce((m, s) => Math.max(m, s.updatedAt || 0), 0);
  const localUsage = (fiveHourSessions || todaySessions)
    ? { fiveHour: { messages: fiveHourSessions, totalTokens: 0 }, today: { messages: todaySessions, totalTokens: 0 }, unit: 'sessions' }
    : null;
  const windows = snap ? snap.windows : [];
  const plan = snap?.plan || membership?.plan || null;
  const hasAny = windows.length > 0 || Boolean(plan) || Boolean(localUsage);

  return {
    id: 'cursor',
    name: 'Cursor',
    kind: windows.length ? 'windows' : 'usage',
    state: hasAny ? 'ok' : 'unknown',
    source: windows.length ? 'snapshot' : 'local',
    observedAt: Math.max(snap?.observedAt || 0, latestAt) || (plan ? now : null),
    plan,
    subscriptionStatus: membership?.subscriptionStatus || null,
    windows,
    extras: [],
    localUsage,
  };
}
