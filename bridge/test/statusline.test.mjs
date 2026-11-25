import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire ring statusline '));   // a space, like the app's path
process.env.FIRE_RING_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: { claude: true } }));
const { statusLineQuota, readClaudeQuota } = await import('../src/quota.mjs');
const { STATUSLINE_FILE } = await import('../src/statusline.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const script = path.resolve('src/statusline.mjs');
const nowSec = Math.floor(Date.now() / 1000);
const session = {
  session_id: 'not-kept', cwd: '/somewhere', model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: 41.5, resets_at: nowSec + 3600 }, seven_day: { used_percentage: 12, resets_at: nowSec + 86400 } },
};

test('the status line keeps only the limit numbers and prints a short line', () => {
  const out = execFileSync(process.execPath, [script], { input: JSON.stringify(session), env: { ...process.env, FIRE_RING_DATA_DIR: dir } }).toString();
  assert.match(out, /5 小时 剩 59%/);
  assert.match(out, /本周 剩 88%/);
  const saved = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['observedAt', 'rate_limits']);
  assert.ok(!JSON.stringify(saved).includes('not-kept') && !JSON.stringify(saved).includes('/somewhere'));
});

test('Fire Ring prefers the status line numbers to the account', () => {
  const q = readClaudeQuota();
  assert.equal(q.source, 'statusline');
  assert.deepEqual(q.windows.map((w) => [w.kind, w.leftPercent]), [['five_hour', 58.5], ['weekly', 88]]);
});

test('no numbers from the status line: nothing is written, nothing is shown from it', () => {
  fs.rmSync(STATUSLINE_FILE);
  const out = execFileSync(process.execPath, [script], { input: JSON.stringify({ model: {} }), env: { ...process.env, FIRE_RING_DATA_DIR: dir } }).toString();
  assert.equal(out, 'Fire Ring');
  assert.equal(fs.existsSync(STATUSLINE_FILE), false);
  assert.equal(statusLineQuota(), null);
});
