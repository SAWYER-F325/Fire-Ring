// Reads DeepSeek Harness session state from its own projection cache.
//
// DSH keeps one JSON per session in ~/.dsh/storages/session_projcache/sessions/.
// Each file is a projection of the live session record (title, cwd, turn
// boundary, pending questions, last user prompt). It is rewritten while a turn
// runs, so polling it is enough to know every session's state without touching
// the transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CACHE_DIR = process.env.DSH_BRIDGE_CACHE_DIR
  || path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');

function shortProject(cwd) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return '…/' + parts.slice(-2).join('/');
}

function completedTurns(boundary) {
  const last = Number(boundary.lastTurn);
  if (!Number.isFinite(last)) return undefined;
  const open = boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined;
  return open ? last - 1 : last;
}

export function readSessions() {
  let files;
  try {
    files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  const sessions = [];
  for (const file of files) {
    const full = path.join(CACHE_DIR, file);
    let stat;
    let json;
    try {
      stat = fs.statSync(full);
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue; // a cache file can be mid-rewrite; the next tick reads it again
    }

    const record = json?.record ?? {};
    const rows = record.rows ?? {};
    const value = (key) => rows[key]?.val;

    const id = file.slice('session-'.length, -'.json'.length);
    const boundary = value('turnBoundary') ?? {};
    const stats = value('sessionStats') ?? {};
    const questions = value('userQuestions')?.questions ?? {};
    const metadata = value('sessionListMetadata') ?? {};
    const title = typeof value('title') === 'string' ? value('title').trim() : '';
    const cwd = record.identity?.cwd ?? '';

    sessions.push({
      id,
      cwd,
      project: shortProject(cwd),
      title,
      // An open turn is the one signal that means "the agent is working now".
      running: boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined,
      // 已经结束的轮数。回答很快时（一两秒），可能来不及读到「在跑」，
      // 轮数增加就说明又完成了一轮。
      completedTurns: completedTurns(boundary),
      lastPromptAt: Number(metadata.lastPromptAt ?? 0),
      pendingQuestions: Array.isArray(questions.active) ? questions.active.length : 0,
      turns: Number(stats.turns ?? 0),
      cacheMtime: stat.mtimeMs,
    });
  }
  return sessions;
}

/** The session whose conversation the user most recently typed into. */
export function mostRecentPromptId(sessions) {
  let best = null;
  for (const s of sessions) {
    if (!best || s.lastPromptAt > best.lastPromptAt) best = s;
  }
  return best?.lastPromptAt ? best.id : null;
}

export function describe(session) {
  return `${session.project || 'DSH'} · ${session.title || session.id.slice(0, 8)}`;
}
