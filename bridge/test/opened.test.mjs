import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openedSince, VIEW_GRACE_MS } from '../src/status.mjs';

const finishedAt = 1_000_000;

test('a Codex or Claude conversation opened after it finished counts as seen', () => {
  for (const provider of ['codex', 'claude']) {
    assert.equal(openedSince({ provider, viewedAt: finishedAt + VIEW_GRACE_MS + 1 }, finishedAt), true);
  }
});

test('opening it before or just as it finished does not count', () => {
  assert.equal(openedSince({ provider: 'codex', viewedAt: finishedAt - 60_000 }, finishedAt), false);
  assert.equal(openedSince({ provider: 'claude', viewedAt: finishedAt + VIEW_GRACE_MS }, finishedAt), false);
});

test('no record of opening, or nothing finished, never clears', () => {
  assert.equal(openedSince({ provider: 'codex' }, finishedAt), false);
  assert.equal(openedSince({ provider: 'claude', viewedAt: null }, finishedAt), false);
  assert.equal(openedSince({ provider: 'codex', viewedAt: finishedAt + 60_000 }, null), false);
});

test('DeepSeek: watching it finish does not clear it; leaving and coming back does', () => {
  const session = { provider: 'dsh', id: 'a' };
  const later = finishedAt + VIEW_GRACE_MS + 1;
  assert.equal(openedSince(session, finishedAt, { now: later, lookingAt: () => true, wasAway: () => false }), false);
  assert.equal(openedSince(session, finishedAt, { now: later, lookingAt: () => true, wasAway: () => true }), true);
});

test('DeepSeek clears only while that conversation is on screen, after the grace period', () => {
  const session = { provider: 'dsh', id: 'a' };
  const onScreen = { lookingAt: () => true };
  assert.equal(openedSince(session, finishedAt, { now: finishedAt + VIEW_GRACE_MS + 1, ...onScreen }), true);
  assert.equal(openedSince(session, finishedAt, { now: finishedAt + 1000, ...onScreen }), false);
  assert.equal(openedSince(session, finishedAt, { now: finishedAt + 60_000, lookingAt: () => false }), false);
});
