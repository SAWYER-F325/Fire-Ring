import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowOf } from '../src/window.mjs';

const now = 1_800_000_000_000;

test('a live window reports what is left and when it resets', () => {
  const w = windowOf('five_hour', 39, now / 1000 + 3600, now);
  assert.deepEqual(w, { kind: 'five_hour', usedPercent: 39, leftPercent: 61, resetsAt: now + 3_600_000, reset: false });
});

test('a window past its reset time is full again', () => {
  const w = windowOf('weekly', 88, now / 1000 - 60, now);
  assert.equal(w.leftPercent, 100);
  assert.equal(w.reset, true);
  assert.equal(w.resetsAt, null);
});

test('out-of-range or missing numbers are clamped', () => {
  assert.equal(windowOf('weekly', 140, now / 1000 + 60, now).leftPercent, 0);
  assert.equal(windowOf('weekly', undefined, now / 1000 + 60, now).leftPercent, 100);
});

