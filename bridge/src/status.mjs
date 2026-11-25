// The one place that decides what "finished" means.
//
// A turn that ends while you watch it still counts as finished; the mark clears
// once you have left that conversation and come back to it (see openedSince).
//
// A turn counts as finished only when a session we saw running is still listed
// and is no longer running. A session that merely vanished from a read (a cache
// file caught mid-rewrite, a provider read that failed) is not finished: it gets
// a grace period, and if it never comes back it is dropped silently.

export const MISSING_GRACE_MS = 60_000;
// After a turn is seen to stop, the cached turn count can lag a moment behind;
// that late count is the same turn, not a new one.
const COUNT_LAG_MS = 15_000;
const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function createTracker({
  finished = {},
  now = Date.now,
  onChange = () => {},
} = {}) {
  const finishedAt = new Map();
  const cutoff = now() - FINISHED_KEEP_MS;
  for (const [id, at] of Object.entries(finished)) {
    if (Number.isFinite(at) && at >= cutoff) finishedAt.set(id, at);
  }
  const running = new Map(); // id -> when it was last seen running
  const turns = new Map();   // id -> completed turns last seen (DeepSeek reports them)
  const endedAt = new Map(); // id -> when its latest turn ended
  const stoppedAt = new Map(); // id -> when it was last seen to stop running

  const changed = () => onChange(Object.fromEntries(finishedAt));

  return {
    update(sessions) {
      const at = now();
      const byId = new Map(sessions.map((s) => [s.id, s]));
      let dirty = false;
      const ended = new Set();

      // A turn ended.
      const end = (session) => {
        ended.add(session.id);
        // quietEnd: interrupted by the user, or went silent. Not a completion.
        if (session.quietEnd) return;
        endedAt.set(session.id, at);
        finishedAt.set(session.id, at);
        dirty = true;
      };

      for (const [id, seenAt] of running) {
        const session = byId.get(id);
        if (!session) {
          if (at - seenAt > MISSING_GRACE_MS) running.delete(id);
          continue;
        }
        if (session.running) continue;
        running.delete(id);
        stoppedAt.set(id, at);
        end(session);
      }

      // A turn that started and ended between two reads: only the count moved.
      for (const session of sessions) {
        if (!Number.isFinite(session.completedTurns)) continue;
        const before = turns.get(session.id);
        turns.set(session.id, session.completedTurns);
        if (before === undefined || session.completedTurns <= before || ended.has(session.id)) continue;
        if (session.running && running.has(session.id)) continue;   // still in the turn we already saw start
        if (at - (stoppedAt.get(session.id) ?? -Infinity) < COUNT_LAG_MS) continue;   // the count catching up
        end(session);
      }

      for (const session of sessions) {
        if (!session.running) continue;
        running.set(session.id, at);
        if (finishedAt.delete(session.id)) dirty = true;
      }

      if (dirty) changed();
    },
    dismiss(id) {
      if (finishedAt.delete(id)) changed();
    },
    finishedAt: (id) => finishedAt.get(id) ?? null,
    /** When this session's latest turn ended, including one you watched end. */
    endedAt: (id) => endedAt.get(id) ?? null,
  };
}

export const VIEW_GRACE_MS = 5_000;

/**
 * Whether a finished session has since been opened in its own app.
 * DeepSeek says which conversation is on screen; Claude and Codex record when
 * a conversation was opened (`viewedAt`). The grace period lets an app first
 * record the completion itself, so it is not mistaken for a visit.
 */
export function openedSince(session, finishedAt, { now = Date.now(), lookingAt = () => false, wasAway = () => true } = {}) {
  if (finishedAt === null || finishedAt === undefined) return false;
  // DeepSeek: you left that conversation after it finished and are looking at it again.
  if (session.provider === 'dsh') return now - finishedAt > VIEW_GRACE_MS && wasAway(session) && lookingAt(session);
  return Number.isFinite(session.viewedAt) && session.viewedAt > finishedAt + VIEW_GRACE_MS;
}

/** The single status every UI shows. What needs you outranks what is done. */
export function statusOf({ waiting, finished, running }) {
  if (waiting) return 'waiting';
  if (finished) return 'finished';
  if (running) return 'running';
  return 'idle';
}
