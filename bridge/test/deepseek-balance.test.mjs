import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-deepseek-'));
process.env.FIRE_RING_DATA_DIR = dir;
const { balancesFrom, validKeyShape } = await import('../src/deepseek-balance.mjs');
const { readQuota } = await import('../src/quota.mjs');
const { writeConfig } = await import('../src/config.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("DeepSeek's balance answer becomes numbers per currency", () => {
  const body = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  };
  assert.deepEqual(balancesFrom(body), [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }]);
  assert.deepEqual(balancesFrom({}), []);
  assert.deepEqual(balancesFrom({ balance_infos: [{ currency: 'USD', total_balance: 'x' }] }), []);
});

test('only API keys of the expected shape are accepted', () => {
  assert.ok(validKeyShape('sk-' + 'a1B2'.repeat(8)));
  assert.ok(!validKeyShape('sk-short'));
  assert.ok(!validKeyShape('pk-' + 'a'.repeat(32)));
  assert.ok(!validKeyShape('sk-' + 'a'.repeat(20) + ' rm -rf'));
  assert.ok(!validKeyShape(undefined));
});

test('the balance appears only for a connected DeepSeek with its switch on', () => {
  writeConfig({ providers: { dsh: false }, quota: { dsh: true } });
  assert.ok(!readQuota().some((q) => q.id === 'dsh'));
  writeConfig({ providers: { dsh: true }, quota: { dsh: false } });
  assert.ok(!readQuota().some((q) => q.id === 'dsh'));
  writeConfig({ quota: { dsh: true } });
  const q = readQuota().find((x) => x.id === 'dsh');
  assert.equal(q.kind, 'balance');
});

test('spending counts drops between readings and ignores top-ups', async () => {
  const { spendingFrom } = await import('../src/deepseek-balance.mjs');
  const now = new Date(2026, 10, 18, 15, 0).getTime();
  const h = (hoursAgo, total) => ({ at: now - hoursAgo * 3600_000, total, currency: 'CNY' });
  const s = spendingFrom([h(50, 100), h(30, 90), h(10, 85), h(5, 120), h(1, 118.5)], now);
  assert.equal(s.currency, 'CNY');
  assert.equal(s.today, 6.5);            // a drop counts on the day of the later reading: 5 (seen at 05:00) + 1.5; the 35 top-up is not spending
  assert.equal(s.week, 16.5);            // 10 + 5 + 1.5; the top-up is not spending
  assert.deepEqual(s.day.map((p) => p.total), [85, 120, 118.5]);
  assert.deepEqual(spendingFrom([], now).day, []);
});
