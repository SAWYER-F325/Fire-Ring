import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodex } from '../src/providers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-codex-'));
let n = 0;
let ordinal = 0;
const t = () => new Date(Date.now() - 60000 + (ordinal += 1) * 100).toISOString();
const meta = () => ({ type: 'session_meta', timestamp: t(), payload: { id: 'thread-' + n, cwd: '/x/p', thread_source: 'user' } });
const event = (type, extra = {}) => ({ type: 'event_msg', ordinal: (ordinal += 1), timestamp: t(), payload: { type, ...extra } });
const userSays = (text) => ({ type: 'response_item', timestamp: t(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const call = (name, callId = 'c1') => ({ type: 'response_item', timestamp: t(), payload: { type: 'function_call', name, call_id: callId, arguments: '{}' } });
const output = (text, callId = 'c1') => ({ type: 'response_item', timestamp: t(), payload: { type: 'function_call_output', call_id: callId, output: text } });

function rollout(records) {
  n += 1;
  const file = path.join(dir, 'rollout-' + n + '.jsonl');
  fs.writeFileSync(file, [meta(), ...records].map((r) => JSON.stringify(r)).join('\n'));
  return parseCodex(file);
}

test('a question sent with request_user_input_async waits on you after the turn ends', () => {
  const s = rollout([event('task_started'), userSays('ask me'), call('request_user_input_async'), output('{"accepted":true}'), event('task_complete')]);
  assert.equal(s.waiting, true);
  assert.equal(s.running, false);
});

test('your next message answers it', () => {
  const s = rollout([event('task_started'), userSays('ask me'), call('request_user_input_async'), output('{"accepted":true}'), event('task_complete'),
    event('task_started'), userSays('确认采用')]);
  assert.equal(s.waiting, false);
  assert.equal(s.running, true);
});

test('the synchronous form is answered by its own output', () => {
  const s = rollout([event('task_started'), userSays('ask me'), call('request_user_input'), output('{"answers":["确认采用"]}')]);
  assert.equal(s.waiting, false);
});

test('an approval request waits until its command runs', () => {
  const waiting = rollout([event('task_started'), userSays('run it'), event('exec_approval_request', { call_id: 'c9' })]);
  assert.equal(waiting.waiting, true);
  const done = rollout([event('task_started'), userSays('run it'), event('exec_approval_request', { call_id: 'c9' }), output('ok', 'c9')]);
  assert.equal(done.waiting, false);
});

test('an ordinary finished turn does not wait', () => {
  const s = rollout([event('task_started'), userSays('hi'), event('task_complete')]);
  assert.equal(s.waiting, false);
});

test('picking an option in Codex answers the question (the reply arrives tagged)', () => {
  const reply = '<send_user_message_question_reply> [{"questionItemId":"[\\"request_user_input_async\\",\\"c1\\",0]","answer":"确认采用"}]';
  const s = rollout([event('task_started'), userSays('ask me'), call('request_user_input_async'), output('{"accepted":true}'), event('task_complete'),
    event('task_started'), userSays(reply), event('task_complete')]);
  assert.equal(s.waiting, false);
  assert.equal(s.running, false);
});

test('a new turn alone also ends the wait', () => {
  const s = rollout([event('task_started'), userSays('ask me'), call('request_user_input_async'), output('{"accepted":true}'), event('task_complete'), event('task_started')]);
  assert.equal(s.waiting, false);
});

test('a subagent forked with the parent history is not read as the parent', () => {
  n += 1;
  const file = path.join(dir, 'rollout-' + n + '.jsonl');
  const own = { type: 'session_meta', timestamp: t(), payload: { id: 'child-' + n, session_id: 'parent', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } } };
  const parent = { type: 'session_meta', timestamp: t(), payload: { id: 'parent', session_id: 'parent', cwd: '/x/p', thread_source: 'user', source: 'vscode' } };
  fs.writeFileSync(file, [own, parent, event('task_started'), userSays('review it'), event('task_complete')].map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(parseCodex(file), null);
});

test('codex exec started by another program (one image for Claude) is not its own task', () => {
  n += 1;
  const file = path.join(dir, 'rollout-' + n + '.jsonl');
  const execMeta = { type: 'session_meta', timestamp: t(), payload: { id: 'exec-' + n, cwd: '/x/imagegen', thread_source: 'user', source: 'exec', originator: 'codex_exec' } };
  fs.writeFileSync(file, [execMeta, event('task_started'), userSays('$imagegen 生成一张图'), event('task_complete')].map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(parseCodex(file), null);
});
