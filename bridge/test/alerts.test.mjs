import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlerts, MAX_REMINDERS } from '../src/alerts.mjs';
import { normalizeAlerts } from '../src/config.mjs';

function setup(alertPatch = {}, { codex = null, deepseek = null } = {}) {
  let t = 1_000_000_000;
  const alerts = normalizeAlerts(alertPatch);
  const cfg = { alerts, providers: { claude: true, codex: true, dsh: true } };
  const a = createAlerts({ now: () => t, config: () => cfg, codexQuota: () => codex, deepseekBalance: () => deepseek });
  return { a, cfg, tick: (ms) => { t += ms; }, now: () => t };
}
const s = (id, status, extra = {}) => ({ id, status, provider: 'codex', title: '任务 ' + id, ...extra });
const kinds = (a) => a.latest().events.map((e) => e.kind);

test('第一次读取只当基线，不提醒', () => {
  const { a } = setup();
  a.observe([s('a', 'waiting'), s('b', 'finished')]);
  assert.deepEqual(kinds(a), []);
});

test('开始等你和一轮做完各提醒一次，带上默认声音', () => {
  const { a } = setup();
  a.observe([s('a', 'running'), s('b', 'running')]);
  a.observe([s('a', 'waiting'), s('b', 'finished')]);
  a.observe([s('a', 'waiting'), s('b', 'finished')]);
  const [wait, done] = a.latest().events;
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.sound, 'fr-ask');
  assert.equal(wait.notify, true);
  assert.equal(wait.title, 'Codex 在等你');
  assert.equal(wait.body, '任务 a');
  assert.equal(done.kind, 'done');
  assert.equal(done.sound, 'fr-arp');
  assert.equal(done.notify, false);
  assert.equal(a.latest().events.length, 2);
});

test('关掉通知里的标题后只写概括', () => {
  const { a } = setup({ notify: { title: false } });
  a.observe([s('a', 'running')]);
  a.observe([s('a', 'waiting')]);
  const [e] = a.latest().events;
  assert.equal(e.title, 'Codex 有 1 个任务在等你');
  assert.equal(e.body, '打开 Fire Ring 查看');
});

test('一直没处理时按间隔再次提醒，最多 3 次', () => {
  const { a, tick } = setup({ remind: 5 });
  a.observe([s('a', 'running')]);
  a.observe([s('a', 'waiting')]);
  for (let i = 0; i < 10; i++) { tick(5 * 60_000); a.observe([s('a', 'waiting')]); }
  assert.equal(kinds(a).filter((k) => k === 'remind').length, MAX_REMINDERS);
});

test('「不再提醒」时不重复提醒', () => {
  const { a, tick } = setup({ remind: 0 });
  a.observe([s('a', 'running')]);
  a.observe([s('a', 'waiting')]);
  tick(60 * 60_000);
  a.observe([s('a', 'waiting')]);
  assert.deepEqual(kinds(a), ['wait']);
});

test('暂停期间不提醒', () => {
  const { a, cfg, now, tick } = setup();
  cfg.alerts.pausedUntil = now() + 60_000;
  a.observe([s('a', 'running')]);
  a.observe([s('a', 'waiting')]);
  assert.deepEqual(kinds(a), []);
  tick(120_000);
  a.observe([s('b', 'running')]);
  a.observe([s('b', 'waiting')]);
  assert.deepEqual(kinds(a), ['wait']);
});

test('某个工具关掉「完成」后不提醒它的完成', () => {
  const { a } = setup({ tools: { codex: { done: false } } });
  a.observe([s('a', 'running'), s('b', 'running', { provider: 'claude' })]);
  a.observe([s('a', 'finished'), s('b', 'finished', { provider: 'claude' })]);
  const events = a.latest().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Claude Code 完成了');
});

test('没有声音也不发通知时什么都不产生', () => {
  const { a } = setup({ sounds: { done: 'none' }, notify: { done: false } });
  a.observe([s('a', 'running')]);
  a.observe([s('a', 'finished')]);
  assert.deepEqual(kinds(a), []);
});

test('Codex 额度降到设定值以下提醒一次，重置后再降才再提醒', () => {
  const codex = { state: 'ok', windows: [{ kind: 'five_hour', leftPercent: 50, resetsAt: 2_000_000, reset: false }] };
  const { a, tick } = setup({ codexLow: 20 }, { codex });
  a.observe([]);
  codex.windows[0].leftPercent = 15;
  tick(61_000); a.observe([]);
  tick(61_000); a.observe([]);
  assert.deepEqual(kinds(a), ['quota']);
  assert.match(a.latest().events[0].title, /Codex 5 小时额度剩 15%/);
  codex.windows[0] = { kind: 'five_hour', leftPercent: 100, resetsAt: 3_000_000, reset: false };
  tick(61_000); a.observe([]);
  codex.windows[0].leftPercent = 10;
  tick(61_000); a.observe([]);
  assert.deepEqual(kinds(a), ['quota', 'quota']);
});

test('启动时额度已经很低，不在启动时提醒', () => {
  const codex = { state: 'ok', windows: [{ kind: 'weekly', leftPercent: 5, resetsAt: 2_000_000, reset: false }] };
  const { a, tick } = setup({ codexLow: 20 }, { codex });
  a.observe([]);
  tick(61_000); a.observe([]);
  assert.deepEqual(kinds(a), []);
});

test('DeepSeek 余额低于设定金额时提醒一次', () => {
  const deepseek = { balances: [{ currency: 'CNY', total: 30 }] };
  const { a, tick } = setup({ dsLow: { on: true, amount: 10 } }, { deepseek });
  a.observe([]);
  deepseek.balances[0].total = 8.5;
  tick(61_000); a.observe([]);
  tick(61_000); a.observe([]);
  assert.deepEqual(kinds(a), ['quota']);
  assert.equal(a.latest().events[0].title, 'DeepSeek 余额只剩 ¥8.50');
});

test('设置里的值会被校正', () => {
  const n = normalizeAlerts({ sounds: { wait: 'evil', done: 'mac-Glass' }, volume: 900, remind: 7, codexLow: 55, dsLow: { amount: -3 } });
  assert.equal(n.sounds.wait, 'fr-ask');
  assert.equal(n.sounds.done, 'mac-Glass');
  assert.equal(n.volume, 100);
  assert.equal(n.remind, 10);
  assert.equal(n.codexLow, 20);
  assert.equal(n.dsLow.amount, 10);
});

test('一轮结束就响「完成」，你正看着它结束时也响', () => {
  const { a } = setup();
  a.observe([s('d', 'idle', { provider: 'dsh', turnEndedAt: null })]);
  a.observe([s('d', 'idle', { provider: 'dsh', turnEndedAt: 1234 })]);
  a.observe([s('d', 'idle', { provider: 'dsh', turnEndedAt: 1234 })]);
  const events = a.latest().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'done');
  assert.equal(events[0].title, 'DeepSeek 完成了');
});

test('结束时间和状态都变了，只响一次', () => {
  const { a } = setup();
  a.observe([s('a', 'running', { turnEndedAt: null })]);
  a.observe([s('a', 'finished', { turnEndedAt: 999 })]);
  assert.deepEqual(kinds(a), ['done']);
});
