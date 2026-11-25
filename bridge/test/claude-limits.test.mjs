import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-limits-'));
process.env.HOME = home;
process.env.FIRE_RING_DATA_DIR = path.join(home, 'data');
const project = path.join(home, '.claude', 'projects', 'p');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(process.env.FIRE_RING_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.FIRE_RING_DATA_DIR, 'config.json'), JSON.stringify({ providers: { claude: true } }));
const { readClaudeQuota } = await import('../src/quota.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const refusal = (type, resetsAt, at = new Date().toISOString()) => JSON.stringify({
  type: 'assistant', isApiErrorMessage: true, timestamp: at,
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: type } },
});

test('nothing used up: no numbers, and no network request', () => {
  fs.writeFileSync(path.join(project, 'a.jsonl'), JSON.stringify({ type: 'user' }) + '\n');
  const q = readClaudeQuota();
  assert.equal(q.state, 'limits_only');
  assert.deepEqual(q.windows, []);
});

test('a used-up 5-hour limit shows as 0% left until it resets', () => {
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(project, 'b.jsonl'), [refusal('five_hour', now + 1800), refusal('seven_day', now - 60)].join('\n') + '\n');
  const q = readClaudeQuota();
  assert.equal(q.state, 'ok');
  assert.deepEqual(q.windows.map((w) => [w.kind, w.leftPercent, w.resetsAt]), [['five_hour', 0, (now + 1800) * 1000]]);
});

test('a refusal followed by a real reply no longer counts as used up', () => {
  const now = Math.floor(Date.now() / 1000);
  const earlier = new Date(Date.now() - 3600_000).toISOString();
  const reply = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  fs.writeFileSync(path.join(project, 'b.jsonl'), [refusal('five_hour', now + 7200, earlier), reply].join('\n') + '\n');
  const q = readClaudeQuota();
  assert.equal(q.state, 'limits_only');
  assert.deepEqual(q.windows, []);
});
