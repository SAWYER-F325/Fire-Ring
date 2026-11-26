import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-quota-order-'));
process.env.FIRE_RING_DATA_DIR = dir;
const { PROVIDER_IDS, normalizeQuotaOrder, readConfig, writeConfig, resetPreferences } = await import('../src/config.mjs');
const { readQuota } = await import('../src/quota.mjs');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('quotaOrder defaults to PROVIDER_IDS, normalizes invalid/duplicate entries, persists and resets', () => {
  assert.deepEqual(readConfig().quotaOrder, PROVIDER_IDS);
  assert.deepEqual(
    normalizeQuotaOrder(['codex', 'unknown', 'codex', 'claude']),
    ['codex', 'claude', ...PROVIDER_IDS.filter((id) => id !== 'codex' && id !== 'claude')],
  );

  const reversed = [...PROVIDER_IDS].reverse();
  writeConfig({ quotaOrder: reversed });
  assert.deepEqual(readConfig().quotaOrder, reversed);

  resetPreferences();
  assert.deepEqual(readConfig().quotaOrder, PROVIDER_IDS);
});

test('readQuota returns connected tools in the user-chosen quotaOrder', () => {
  writeConfig({
    providers: { claude: true, codex: true },
    quota: { claude: true, codex: true },
    quotaOrder: ['codex', 'claude'],
  });
  assert.deepEqual(readQuota().map((q) => q.id), ['codex', 'claude']);

  writeConfig({ quotaOrder: ['claude', 'codex'] });
  assert.deepEqual(readQuota().map((q) => q.id), ['claude', 'codex']);
});
