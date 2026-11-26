import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-mbquota-'));
process.env.FIRE_RING_DATA_DIR = dir;
const { readConfig, writeConfig, resetPreferences } = await import('../src/config.mjs');
const { formatMenuBarItem, menuBarQuotaText } = await import('../src/quota.mjs');
const { STATUSLINE_FILE } = await import('../src/statusline.mjs');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('menuBarQuota defaults to off, persists per provider, and resets cleanly', () => {
  const initial = readConfig().menuBarQuota;
  assert.equal(initial.claude, false);
  assert.equal(initial.codex, false);
  assert.equal(initial.dsh, false);

  writeConfig({ menuBarQuota: { claude: true, codex: true } });
  assert.equal(readConfig().menuBarQuota.claude, true);
  assert.equal(readConfig().menuBarQuota.codex, true);
  assert.equal(readConfig().menuBarQuota.dsh, false);

  resetPreferences();
  assert.equal(readConfig().menuBarQuota.claude, false);
  assert.equal(readConfig().menuBarQuota.codex, false);
});

test('formatMenuBarItem formats windows, balances, local usage, plans, and fallback cleanly', () => {
  assert.equal(
    formatMenuBarItem({
      id: 'claude',
      windows: [
        { kind: 'five_hour', leftPercent: 80 },
        { kind: 'weekly', leftPercent: 22.4 },
      ],
    }, false),
    'Claude 22%',
  );
  assert.equal(
    formatMenuBarItem({
      id: 'claude',
      windows: [{ kind: 'five_hour', leftPercent: 65 }],
    }, true),
    'C 65%',
  );
  assert.equal(
    formatMenuBarItem({
      id: 'dsh',
      kind: 'balance',
      balances: [{ currency: 'CNY', total: 42.36 }],
    }, false),
    'DeepSeek ¥42.4',
  );
  assert.equal(
    formatMenuBarItem({
      id: 'antigravity',
      kind: 'usage',
      windows: [],
      localUsage: { fiveHour: { messages: 18 }, today: { messages: 25 } },
    }, true),
    'AG 18次',
  );
  assert.equal(
    formatMenuBarItem({
      id: 'cursor',
      kind: 'usage',
      windows: [],
      plan: 'pro',
      localUsage: null,
    }, true),
    'Cu Pro',
  );
  assert.equal(
    formatMenuBarItem({ id: 'grok', windows: [] }, false),
    'Grok —',
  );
});

test('menuBarQuotaText respects connected providers and switches from full to compact labels', () => {
  const now = Date.now();
  fs.writeFileSync(STATUSLINE_FILE, JSON.stringify({
    observedAt: now,
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: Math.floor((now + 3600_000) / 1000) },
      seven_day: { used_percentage: 78, resets_at: Math.floor((now + 86400_000) / 1000) },
    },
  }));

  // Disconnected provider produces no text even if toggled on.
  writeConfig({ providers: { claude: false, codex: false }, menuBarQuota: { claude: true, codex: false } });
  assert.equal(menuBarQuotaText(now), '');

  // Single selected provider uses its full name and tightest window.
  writeConfig({ providers: { claude: true, codex: false }, menuBarQuota: { claude: true } });
  assert.equal(menuBarQuotaText(now), 'Claude 22%');

  // Multiple selected providers switch to compact labels joined by double spaces.
  writeConfig({ providers: { claude: true, codex: true }, menuBarQuota: { claude: true, codex: true } });
  const multi = menuBarQuotaText(now);
  assert.ok(multi.startsWith('C 22%  X '), `expected compact multi-provider output, got: ${multi}`);
});
