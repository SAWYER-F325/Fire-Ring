import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-providers-'));
process.env.FIRE_RING_DATA_DIR = dir;
const { readConfig, writeConfig } = await import('../src/config.mjs');
const { readQuota } = await import('../src/quota.mjs');
const { detectTools } = await import('../src/integrations.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('nothing is connected until the user connects it', () => {
  assert.deepEqual(readConfig().providers, {
    claude: false, codex: false, dsh: false, antigravity: false, cursor: false, grok: false,
  });
  assert.deepEqual(readQuota(), []);   // no quota is read, and Claude is never asked over the network
  assert.ok(detectTools().every((t) => t.connected === false));
});

test('connecting one tool leaves the others as they were', () => {
  writeConfig({ providers: { codex: true } });
  assert.deepEqual(readConfig().providers, {
    claude: false, codex: true, dsh: false, antigravity: false, cursor: false, grok: false,
  });
  assert.deepEqual(readQuota().map((q) => q.id), ['codex']);
  writeConfig({ providers: { dsh: true } });
  writeConfig({ providers: { codex: false } });
  assert.deepEqual(readConfig().providers, {
    claude: false, codex: false, dsh: true, antigravity: false, cursor: false, grok: false,
  });
});

test('limits are shown only for tools the user chose; Claude is off by default', async () => {
  const { connectedQuota } = await import('../src/quota.mjs');
  writeConfig({ providers: { claude: true, codex: true } });
  assert.deepEqual(readConfig().quota, { claude: false, codex: true, dsh: false });
  assert.deepEqual(readQuota().map((q) => q.id), ['codex']);
  // Fire Ring itself still sees every connected tool, e.g. to know a limit is used up.
  assert.deepEqual(connectedQuota().map((q) => q.id), ['claude', 'codex']);
  writeConfig({ quota: { claude: true, codex: false } });
  assert.deepEqual(readQuota().map((q) => q.id), ['claude']);
  writeConfig({ quota: { codex: true } });
  assert.deepEqual(readConfig().quota, { claude: true, codex: true, dsh: false });
});
