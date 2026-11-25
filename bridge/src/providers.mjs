// Other agents, read from the logs they already write.
//
// Codex Desktop / CLI  → ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
//   session_meta carries id + cwd; task_started / task_complete carry the state;
//   codex://threads/<id> opens that thread.
//
// Claude Code → ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//   the last event tells whether a turn is still open; resuming goes through
//   `claude --resume <id>` in the session's folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CODEX_ROOT = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : path.join(HOME, '.codex', 'sessions');
const CLAUDE_ROOT = path.join(HOME, '.claude', 'projects');

const CODEX_DB = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, 'state_5.sqlite')
  : path.join(HOME, '.codex', 'state_5.sqlite');

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 一天前的会话不放进列表
const MAX_FILES = 24;
// A "running" session whose log has not moved for this long crashed or was
// closed. It leaves the running list without counting as a completion.
const STALE_MS = 20 * 60 * 1000;
// Work left running in the background after a turn ends (a long build, a
// check). Some never report back (a dev server), so after this long with
// nothing written it no longer counts as running.
const BACKGROUND_STALE_MS = 60 * 60 * 1000;
// A background task counts as work for this long after it starts.
const BACKGROUND_WORK_MS = 60 * 60 * 1000;
// Commands meant to stay up (preview servers, watchers) are not work in progress.
const STAYS_UP = /http\.server|\bserve\b|\bdev\b|--watch|\bwatch\b|tail -f|preview|vite|webpack-dev|nodemon/i;
const CLAUDE_DESKTOP_BUNDLE = 'com.anthropic.claudefordesktop';

// The desktop app keeps one metadata file per conversation, keyed by its own
// local_ id. That id, not the transcript's, is what its deep link accepts.
const DESKTOP_SESSIONS_ROOT = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const DESKTOP_RESCAN_MS = 0;   // every refresh: opening a conversation should clear it at once
let desktopIndex = new Map();
let desktopScannedAt = 0;
const desktopFiles = new Map(); // file -> { mtime, entry }

function desktopSessionFiles(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) desktopSessionFiles(full, depth + 1, out);
    else if (entry.name.startsWith('local_') && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function desktopSessions() {
  const now = Date.now();
  if (now - desktopScannedAt < DESKTOP_RESCAN_MS) return desktopIndex;
  desktopScannedAt = now;
  const next = new Map();
  for (const file of desktopSessionFiles(DESKTOP_SESSIONS_ROOT)) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      let known = desktopFiles.get(file);
      if (!known || known.mtime !== mtime) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        known = { mtime, entry: { cli: raw.cliSessionId, id: raw.sessionId, title: raw.title, focused: raw.lastFocusedAt } };
        desktopFiles.set(file, known);
      }
      if (known.entry.cli && known.entry.id) next.set(known.entry.cli, known.entry);
    } catch {
      /* being rewritten; the next scan picks it up */
    }
  }
  desktopIndex = next;
  return desktopIndex;
}

function linkToDesktop(session) {
  if (session.open?.kind !== 'app') return session;
  const desktop = desktopSessions().get(session.id);
  if (!desktop) return session;
  return {
    ...session,
    title: desktop.title || session.title,
    open: { kind: 'url', value: 'claude://code/continue?session=' + encodeURIComponent(desktop.id) },
    // When you last opened this conversation in the app.
    viewedAt: Number.isFinite(desktop.focused) ? desktop.focused : null,
  };
}

function settle(session, mtime) {
  const limit = session.backgroundOnly ? BACKGROUND_STALE_MS : STALE_MS;
  if (!session.running || Date.now() - mtime < limit) return session;
  return { ...session, running: false, quietEnd: true, stale: true };
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// Parsed files are cached by (mtime, size): these logs grow while an agent runs,
// so an unchanged file never needs reading twice.
const cache = new Map();

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Claude subagent transcripts share the parent's session id.
      if (entry.name !== 'subagents') walk(full, out, depth + 1);
    }
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** The Codex logs written most recently, newest first. */
export function latestCodexFiles(limit, maxAge = MAX_AGE_MS) {
  return recentFiles(CODEX_ROOT, limit, maxAge);
}

function recentFiles(root, limit = MAX_FILES, maxAge = MAX_AGE_MS) {
  const now = Date.now();
  const files = [];
  for (const file of walk(root)) {
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > maxAge) continue;
      files.push({ file, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      /* ignore */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function firstLine(text) {
  return text.split('\n').find((line) => line.trim().length > 0) ?? '';
}

/* ── Codex ─────────────────────────────────────────────────────────── */

// Codex keeps the conversation's short name (the one its own sidebar shows) in
// state_5.sqlite -> threads.name. The rollout log only has the raw prompt, so
// the name is read from there and cached briefly.
let codexTitleCache = { at: 0, map: new Map() };

async function codexThreadNames() {
  if (Date.now() - codexTitleCache.at < 30_000) return codexTitleCache.map;
  const map = new Map();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(CODEX_DB, { readOnly: true });
    const rows = db.prepare('select id, name, thread_source from threads order by updated_at desc').all();
    for (const row of rows) {
      if (!row.id) continue;
      const previous = map.get(row.id);
      if (!previous || !previous.name) map.set(row.id, { name: row.name || '', source: row.thread_source || '' });
    }
    db.close();
  } catch {
    /* database busy or unavailable: fall back to the prompt */
  }
  codexTitleCache = { at: Date.now(), map };
  return map;
}

export async function primeCodexTitles() {
  await codexThreadNames();
}

export function parseCodex(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  let meta = null;
  let title = '';
  let lastStart = -1;
  let lastComplete = -1;
  let lastAborted = -1;
  let updatedAt = 0;
  // Waiting on the person: a question sent with request_user_input (the async
  // form ends the turn and leaves the question on screen), or an approval
  // request still unanswered. Positions are line numbers, so "later" is plain.
  let position = 0;
  let askedAt = -1;
  let lastUserAt = -1;
  let pendingApproval = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    position += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.timestamp) {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at) && at > updatedAt) updatedAt = at;
    }
    // A subagent forked with the parent's history repeats the parent's
    // session_meta right after its own; the first one says whose log this is.
    if (record.type === 'session_meta' && record.payload) {
      if (!meta) meta = record.payload;
      continue;
    }
    if (record.type === 'event_msg' && record.payload) {
      const kind = record.payload.type;
      const ordinal = typeof record.ordinal === 'number' ? record.ordinal : 0;
      if (kind === 'task_started') {
        lastStart = Math.max(lastStart, ordinal);
        if (askedAt >= 0) lastUserAt = position;   // a new turn means the conversation moved on
      }
      if (kind === 'task_complete') lastComplete = Math.max(lastComplete, ordinal);
      if (kind === 'turn_aborted') lastAborted = Math.max(lastAborted, ordinal);
      if (typeof kind === 'string' && kind.endsWith('approval_request')) pendingApproval = record.payload.call_id || kind;
      if (kind === 'task_complete' || kind === 'turn_aborted') pendingApproval = null;
      continue;
    }
    if (record.type === 'response_item' && record.payload) {
      const item = record.payload;
      if (item.type === 'function_call' && String(item.name || '').startsWith('request_user_input')) askedAt = position;
      // The synchronous form returns the answer itself; the async one only says it was sent.
      if (item.type === 'function_call_output' && askedAt > lastUserAt && !String(item.output || '').includes('"accepted"')) lastUserAt = position;
      if (item.type === 'function_call_output' && pendingApproval && item.call_id === pendingApproval) pendingApproval = null;
      // Any later message from the person answers it, including the reply
      // Codex records when an option is picked (<send_user_message_question_reply>).
      if (item.type === 'message' && item.role === 'user' && textOf(item.content).trim()) lastUserAt = position;
    }
    if (!title && record.type === 'response_item' && record.payload && record.payload.type === 'message') {
      if (record.payload.role === 'user') {
        const text = textOf(record.payload.content).replace(/\s+/g, ' ').trim();
        if (text && !text.startsWith('<') && !text.startsWith('You are')) {
          title = text.replace(/[#*`>\-]+\s?/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        }
      }
    }
  }

  if (!meta) return null;
  // Codex runs internal review/subagent threads through the same log format;
  // they are not conversations the user started.
  const source = meta.source && typeof meta.source === 'object' ? meta.source : {};
  const threadSource = String(meta.thread_source || '');
  if (source.subagent || threadSource.startsWith('guardian') || threadSource === 'subagent') return null;
  // `codex exec` runs started by another program (e.g. Claude Code asking Codex
  // for one image): each is a step of that program's task, which shows its own
  // status. Listing them would mark "finished" while the real task still runs.
  if (meta.source === 'exec' || meta.originator === 'codex_exec') return null;
  // meta.id is this rollout's own thread id; meta.session_id is the shared root.
  const id = String(meta.id || meta.session_id || path.basename(file, '.jsonl'));
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  const running = lastStart > Math.max(lastComplete, lastAborted);
  const quietEnd = lastAborted > Math.max(lastStart, lastComplete);

  return {
    id,
    provider: 'codex',
    quietEnd,
    providerName: 'Codex',
    title: title || (cwd ? path.basename(cwd) : 'Codex 会话'),
    project: cwd,
    cwd,
    running,
    waiting: askedAt > lastUserAt || pendingApproval !== null,
    updatedAt,
    open: { kind: 'url', value: 'codex://threads/' + id },
    threadRoot: meta.session_id ? String(meta.session_id) : undefined,
  };
}

// Codex Desktop lists the threads that finished while you were elsewhere and
// drops each one from that list once you open it.
const CODEX_STATE_FILE = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, '.codex-global-state.json')
  : path.join(HOME, '.codex', '.codex-global-state.json');
let codexRead = { mtime: -1, unread: null };

function codexReadState() {
  let mtime;
  try {
    mtime = fs.statSync(CODEX_STATE_FILE).mtimeMs;
  } catch {
    return null;
  }
  if (mtime !== codexRead.mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(CODEX_STATE_FILE, 'utf8'));
      const state = raw['electron-thread-read-state-v1'];
      let unread = null;
      if (state && state.unreadByIdentity) {
        unread = new Set();
        for (const hosts of Object.values(state.unreadByIdentity)) {
          for (const ids of Object.values(hosts || {})) if (Array.isArray(ids)) ids.forEach((id) => unread.add(id));
        }
      }
      codexRead = { mtime, unread };
    } catch {
      /* being rewritten; keep what we had */
    }
  }
  return codexRead.unread ? codexRead : null;
}

export function readCodexSessions() {
  const out = [];
  const names = codexTitleCache.map;
  for (const { file, mtime, size } of recentFiles(CODEX_ROOT)) {
    const key = 'codex:' + file;
    const hit = cache.get(key);
    let session;
    if (hit && hit.mtime === mtime && hit.size === size) {
      session = hit.session;
    } else {
      try {
        session = parseCodex(file);
      } catch {
        session = null;
      }
      cache.set(key, { mtime, size, session });
    }
    if (!session) continue;
    const known = names.get(session.id);
    if (known && known.source && String(known.source).startsWith('guardian')) continue;
    if (known && known.name) session = { ...session, title: known.name };
    out.push({ ...settle(session, mtime), updatedAt: session.updatedAt || mtime, mtime });
  }
  // Codex forks one thread into several rollout files sharing meta.id; keep the
  // file that was written most recently (mtime, not the last record's time).
  const byId = new Map();
  for (const session of out) {
    const previous = byId.get(session.id);
    if (!previous || session.mtime > previous.mtime) byId.set(session.id, session);
  }
  // A thread off the unread list has been opened; the list's last write is the
  // latest moment that could have happened.
  const read = codexReadState();
  return [...byId.values()].map(({ mtime, ...rest }) =>
    read && !read.unread.has(rest.id) ? { ...rest, viewedAt: read.mtime } : rest);
}

/* ── Claude Code ───────────────────────────────────────────────────── */

// Tools that stop a turn until the person answers: a question to choose from,
// or a plan to approve. While one is unanswered the session waits on them.
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);
// The desktop app's end-of-turn box; `blocked` marks the session as waiting on them.
const WRAP_UP = 'mcp__ccd_turn__wrap_up';

export function parseClaude(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return null;

  let sessionId = path.basename(file, '.jsonl');
  let cwd = '';
  let title = '';
  let customTitle = '';
  let entrypoint = '';
  let turn = 'closed'; // open | closed | interrupted
  let updatedAt = 0;
  let limitedUntil = 0; // a usage limit refused the last request until then
  let pendingAsk = null; // a question or plan approval nobody has answered yet
  let blockedOnUser = false; // the turn ended asking for a decision
  const background = new Map(); // background task id -> when it started, until reported done
  const backgroundCalls = new Map(); // tool call id -> when it asked to run in the background

  for (const line of lines) {
    // A finished background task is reported by a <task-notification>, written
    // as a user message, a queued command or a queue entry depending on timing.
    if (line.includes('task-notification')) {
      for (const note of line.matchAll(/<task-notification>[\s\S]*?<task-id>([A-Za-z0-9_-]+)<\/task-id>/g)) background.delete(note[1]);
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.sessionId) sessionId = record.sessionId;
    if (record.cwd) cwd = record.cwd;
    if (record.timestamp) {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at) && at > updatedAt) updatedAt = at;
    }
    if (record.entrypoint) entrypoint = record.entrypoint;
    if (record.type === 'custom-title' && record.customTitle) customTitle = record.customTitle;
    if (record.isSidechain || !record.message) continue;

    // Transcripts carry many bookkeeping records (attachments, snapshots,
    // titles). Only user and assistant messages move the turn.
    if (record.type === 'assistant' && record.isApiErrorMessage) {
      // An API error (a usage limit above all) ends the turn without finishing it.
      const limit = record.apiErrorParams && record.apiErrorParams.rate_limit_info;
      if (limit && limit.status === 'rejected') limitedUntil = (Number(limit.resetsAt) || 0) * 1000;
      turn = 'interrupted';
    } else if (record.type === 'assistant') {
      limitedUntil = 0;
      // A new turn after the one that asked: whoever started it (you, or a
      // message from another Claude session), the question is no longer open.
      if (turn === 'closed') blockedOnUser = false;
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      for (const part of content) {
        if (!part || part.type !== 'tool_use') continue;
        if (part.name === 'TaskStop' && part.input && part.input.task_id) background.delete(String(part.input.task_id));
        if (part.input && part.input.run_in_background === true && !STAYS_UP.test(String(part.input.command || ''))) {
          backgroundCalls.set(part.id, Date.parse(record.timestamp) || Date.now());
        }
        if (ASKS_USER.has(part.name)) pendingAsk = part.id;
        if (part.name === WRAP_UP && part.input && part.input.blocked === true) blockedOnUser = true;
      }
      const stop = record.message.stop_reason;
      const moreToCome = stop === 'tool_use' || stop === 'pause_turn'
        || content.some((part) => part && part.type === 'tool_use');
      turn = moreToCome ? 'open' : 'closed';
    } else if (record.type === 'user' && !record.isMeta) {
      const parts = Array.isArray(record.message.content) ? record.message.content : [];
      const results = parts.filter((part) => part && part.type === 'tool_result');
      if (pendingAsk && results.some((part) => part.tool_use_id === pendingAsk)) pendingAsk = null;
      // "Command running in background with ID: x" starts one; a
      // <task-notification> carrying <task-id>x</task-id> reports it finished.
      // Only a call that asked to run in the background starts one, not any
      // output that happens to quote the message.
      for (const part of results) {
        if (!backgroundCalls.has(part.tool_use_id)) continue;
        const started = textOf(part.content).match(/running in background with ID: ([A-Za-z0-9_-]+)/);
        if (started) background.set(started[1], backgroundCalls.get(part.tool_use_id));
      }
      if (!results.length) blockedOnUser = false;   // a new message from the person is their answer
      const text = textOf(record.message.content).replace(/\s+/g, ' ').trim();
      if (text.startsWith('[Request interrupted')) {
        turn = 'interrupted';
      } else if (!text.startsWith('<command-') && !text.startsWith('<local-command')) {
        // Local slash commands write a user record but never start a turn.
        turn = 'open';
      }
      if (!title && text && !text.startsWith('<')) title = text.slice(0, 80);
    }
  }

  const open = entrypoint === 'claude-desktop'
    ? { kind: 'app', value: CLAUDE_DESKTOP_BUNDLE }
    : { kind: 'terminal', value: `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}` };

  // A message that arrives while the limit holds is never answered: not running.
  const blocked = turn === 'open' && limitedUntil > Date.now();
  // Waiting on the person: an open question, or a turn that ended asking for a decision.
  const asking = turn === 'open' && pendingAsk !== null;
  const waitingOnUser = asking || (turn === 'closed' && blockedOnUser);
  // The turn is over but work it started is still running in the background.
  const now = Date.now();
  const busy = [...background.values()].some((startedAt) => now - startedAt < BACKGROUND_WORK_MS);
  const backgroundOnly = turn !== 'open' && busy && !waitingOnUser;
  return {
    id: sessionId,
    provider: 'claude',
    providerName: 'Claude',
    title: customTitle || title || (cwd ? path.basename(cwd) : 'Claude 会话'),
    project: cwd,
    cwd,
    running: (turn === 'open' && !blocked && !asking) || backgroundOnly,
    quietEnd: (turn === 'interrupted' && !backgroundOnly) || blocked,
    backgroundOnly,
    waiting: waitingOnUser,
    updatedAt,
    open,
  };
}

export function readClaudeSessions() {
  const out = [];
  for (const { file, mtime, size } of recentFiles(CLAUDE_ROOT)) {
    const key = 'claude:' + file;
    const hit = cache.get(key);
    let session;
    if (hit && hit.mtime === mtime && hit.size === size) {
      session = hit.session;
    } else {
      try {
        session = parseClaude(file);
      } catch {
        session = null;
      }
      cache.set(key, { mtime, size, session });
    }
    if (!session) continue;
    out.push({ ...linkToDesktop(settle(session, mtime)), updatedAt: session.updatedAt || mtime });
  }
  return out;
}
