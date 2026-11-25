import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTracker, statusOf, MISSING_GRACE_MS } from '../src/status.mjs';
import { parseClaude, parseCodex } from '../src/providers.mjs';

function clocked(options = {}) {
  let t = 1_000_000;
  const tracker = createTracker({ now: () => t, ...options });
  return { tracker, tick: (ms = 1500) => { t += ms; } };
}

const run = (id, extra = {}) => ({ id, running: true, ...extra });
const idle = (id, extra = {}) => ({ id, running: false, ...extra });

test('running then idle is finished', () => {
  const { tracker } = clocked();
  tracker.update([run('a')]);
  tracker.update([idle('a')]);
  assert.notEqual(tracker.finishedAt('a'), null);
});

test('a session missing for one read is not finished', () => {
  const { tracker, tick } = clocked();
  tracker.update([run('a')]);
  tick();
  tracker.update([]);
  tick();
  tracker.update([run('a')]);
  assert.equal(tracker.finishedAt('a'), null);
});

test('a session that ends while briefly missing still finishes', () => {
  const { tracker, tick } = clocked();
  tracker.update([run('a')]);
  tick();
  tracker.update([]);
  tick();
  tracker.update([idle('a')]);
  assert.notEqual(tracker.finishedAt('a'), null);
});

test('a session gone past the grace period is dropped silently', () => {
  const { tracker, tick } = clocked();
  tracker.update([run('a')]);
  tick(MISSING_GRACE_MS + 1);
  tracker.update([]);
  tick();
  tracker.update([idle('a')]);
  assert.equal(tracker.finishedAt('a'), null);
});

test('interrupted or stale sessions are not finished', () => {
  const { tracker } = clocked();
  tracker.update([run('a')]);
  tracker.update([idle('a', { quietEnd: true })]);
  assert.equal(tracker.finishedAt('a'), null);
});

test('a turn that ends while you watch it is still finished', () => {
  const { tracker } = clocked();
  tracker.update([run('a')]);
  tracker.update([idle('a')]);
  assert.notEqual(tracker.finishedAt('a'), null);
});

test('a new turn clears the mark, and restored marks survive', () => {
  const saved = [];
  const { tracker } = clocked({ finished: { a: 999_000 }, onChange: (f) => saved.push(f) });
  assert.equal(tracker.finishedAt('a'), 999_000);
  tracker.update([run('a')]);
  assert.equal(tracker.finishedAt('a'), null);
  assert.deepEqual(saved.at(-1), {});
});

test('waiting outranks finished', () => {
  assert.equal(statusOf({ waiting: true, finished: true, running: false }), 'waiting');
  assert.equal(statusOf({ waiting: false, finished: true, running: false }), 'finished');
  assert.equal(statusOf({ waiting: false, finished: false, running: true }), 'running');
  assert.equal(statusOf({ waiting: false, finished: false, running: false }), 'idle');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function file(name, records) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, records.map((r) => JSON.stringify(r)).join('\n'));
  return full;
}

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (stop, parts = [{ type: 'text', text: 'x' }]) => ({
  type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: parts },
});

test('claude: a pending tool call is still running', () => {
  const s = parseClaude(file('c1.jsonl', [user('do it'), assistant('tool_use', [{ type: 'tool_use' }])]));
  assert.equal(s.running, true);
});

test('claude: bookkeeping after end_turn does not reopen the turn', () => {
  const s = parseClaude(file('c2.jsonl', [
    user('do it'), assistant('end_turn'),
    { type: 'system', subtype: 'stop_hook_summary' }, { type: 'attachment' }, { type: 'atis-latch' },
  ]));
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, false);
});

test('claude: an interrupt ends the turn quietly', () => {
  const s = parseClaude(file('c3.jsonl', [
    user('do it'), assistant('tool_use', [{ type: 'tool_use' }]),
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
  ]));
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, true);
});

test('claude: a local slash command does not start a turn', () => {
  const s = parseClaude(file('c4.jsonl', [
    user('do it'), assistant('end_turn'),
    user('<command-name>/model</command-name>'), user('<local-command-stdout>ok</local-command-stdout>'),
  ]));
  assert.equal(s.running, false);
});

test('claude: desktop sessions focus the app, titles prefer custom-title', () => {
  const s = parseClaude(file('c5.jsonl', [
    { ...user('first prompt'), entrypoint: 'claude-desktop', cwd: '/tmp/x' },
    assistant('end_turn'), { type: 'custom-title', customTitle: 'Named' },
  ]));
  assert.equal(s.open.kind, 'app');
  assert.equal(s.title, 'Named');
});

test('claude: cli sessions quote the folder for the shell', () => {
  const evil = "/tmp/$(touch pwned)'x";
  const s = parseClaude(file('c6.jsonl', [{ ...user('hi'), cwd: evil }, assistant('end_turn')]));
  assert.equal(s.open.kind, 'terminal');
  assert.ok(s.open.value.startsWith(`cd '/tmp/$(touch pwned)'\\''x' && `));
});

const codexEvent = (type, ordinal) => ({ type: 'event_msg', ordinal, payload: { type } });
const codexMeta = { type: 'session_meta', payload: { id: 'x', cwd: '/tmp' } };

test('codex: an aborted turn is not running and is not a completion', () => {
  const s = parseCodex(file('r1.jsonl', [codexMeta, codexEvent('task_started', 1), codexEvent('turn_aborted', 2)]));
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, true);
});

test('codex: a new turn after an abort runs again', () => {
  const s = parseCodex(file('r2.jsonl', [
    codexMeta, codexEvent('task_started', 1), codexEvent('turn_aborted', 2), codexEvent('task_started', 3),
  ]));
  assert.equal(s.running, true);
  assert.equal(s.quietEnd, false);
});

test('回答很快、两次读取之间就结束的一轮，按轮数算完成', () => {
  const { tracker, tick } = clocked();
  tracker.update([idle('d', { completedTurns: 2 })]);
  tick();
  tracker.update([idle('d', { completedTurns: 3 })]);
  assert.notEqual(tracker.finishedAt('d'), null);
  assert.notEqual(tracker.endedAt('d'), null);
});

test('第一次读到的轮数只当基线', () => {
  const { tracker } = clocked();
  tracker.update([idle('d', { completedTurns: 5 })]);
  assert.equal(tracker.finishedAt('d'), null);
  assert.equal(tracker.endedAt('d'), null);
});

test('确认后接着跑完：显示完成', () => {
  const { tracker, tick } = clocked();
  tracker.update([run('d', { completedTurns: 1, waiting: true })]);
  tick();
  tracker.update([run('d', { completedTurns: 1 })]);
  tick();
  tracker.update([idle('d', { completedTurns: 2 })]);
  assert.notEqual(tracker.finishedAt('d'), null);
});

test('看到停下后，缓存里的轮数晚一会儿才加一，不算第二次完成', () => {
  let changes = 0;
  const { tracker, tick } = clocked({ onChange: () => { changes += 1; } });
  tracker.update([idle('d', { completedTurns: 1 })]);
  tick();
  tracker.update([run('d', { completedTurns: 1 })]);
  tick();
  tracker.update([idle('d', { completedTurns: 1 })]);
  const first = tracker.finishedAt('d');
  tick(1500);
  tracker.update([idle('d', { completedTurns: 2 })]);
  assert.equal(tracker.finishedAt('d'), first);
  assert.equal(changes, 1);
});

test('看到在跑又停下，轮数也加一，只算一次', () => {
  let changes = 0;
  const { tracker, tick } = clocked({ onChange: () => { changes += 1; } });
  tracker.update([idle('d', { completedTurns: 1 })]);
  tick();
  tracker.update([run('d', { completedTurns: 1 })]);
  tick();
  tracker.update([idle('d', { completedTurns: 2 })]);
  assert.notEqual(tracker.finishedAt('d'), null);
  assert.equal(changes, 1);
});

const wrapUp = (blocked) => assistant('tool_use', [{ type: 'tool_use', id: 'w1', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'x', blocked } }]);
const toolResult = (id) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

test('claude: a turn that ends asking you waits on you', () => {
  const s = parseClaude(file('w1.jsonl', [user('do it'), wrapUp(true), toolResult('w1'), assistant('end_turn')]));
  assert.equal(s.waiting, true);
  assert.equal(s.running, false);
});

test('claude: your next message answers it', () => {
  const s = parseClaude(file('w2.jsonl', [user('do it'), wrapUp(true), toolResult('w1'), assistant('end_turn'), user('yes'), assistant('end_turn')]));
  assert.equal(s.waiting, false);
});

test('claude: a turn started by another session also moves past the question', () => {
  const s = parseClaude(file('w3.jsonl', [
    user('do it'), wrapUp(true), toolResult('w1'), assistant('end_turn'),
    user('Another Claude session sent you a message', { isMeta: true }),
    assistant('tool_use', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }]), toolResult('b1'), assistant('end_turn'),
  ]));
  assert.equal(s.waiting, false);
  assert.equal(s.running, false);
});

test('claude: a later turn that asks again waits again', () => {
  const s = parseClaude(file('w4.jsonl', [
    user('do it'), wrapUp(true), toolResult('w1'), assistant('end_turn'),
    user('note', { isMeta: true }), wrapUp(true), toolResult('w1'), assistant('end_turn'),
  ]));
  assert.equal(s.waiting, true);
});
