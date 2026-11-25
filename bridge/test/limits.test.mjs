import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude } from '../src/providers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-'));
let n = 0;
function transcript(records) {
  const file = path.join(dir, 'session-' + (n += 1) + '.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify({ sessionId: 's' + n, ...r })).join('\n'));
  return parseClaude(file);
}
const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const user = (text, minutes) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: text } });
const reply = (minutes, stop = 'end_turn') => ({ type: 'assistant', timestamp: at(minutes), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } });
const limitHit = (minutes, resetsInMinutes) => ({
  type: 'assistant', timestamp: at(minutes), isApiErrorMessage: true,
  apiErrorParams: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.round(Date.now() / 1000) + resetsInMinutes * 60 } },
  message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] },
});

test('hitting the usage limit ends the turn without counting as finished', () => {
  const s = transcript([user('do it', -10), limitHit(-5, 60)]);
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, true);
});

test('a message that arrives while the limit holds is not shown as running', () => {
  const s = transcript([user('do it', -10), limitHit(-5, 60), user('<task-notification>done</task-notification>', -1)]);
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, true);
});

test('once the limit has reset, a new message runs again', () => {
  const s = transcript([user('do it', -90), limitHit(-80, -10), user('continue', -1)]);
  assert.equal(s.running, true);
});

test('a real reply after the limit clears it', () => {
  const s = transcript([limitHit(-30, 60), reply(-20), user('next', -1)]);
  assert.equal(s.running, true);
});

test('an ordinary finished turn is unchanged', () => {
  const s = transcript([user('do it', -10), reply(-5)]);
  assert.equal(s.running, false);
  assert.equal(s.quietEnd, false);
});

const ask = (minutes, id = 'ask1') => ({ type: 'assistant', timestamp: at(minutes), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [] } }] } });
const answer = (minutes, id = 'ask1') => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'picked' }] } });
const wrapUp = (minutes, blocked) => ({ type: 'assistant', timestamp: at(minutes), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w1', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'x', ...(blocked ? { blocked: true } : {}) } }] } });
const wrapUpDone = (minutes) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } });

test('an unanswered question waits on you instead of running', () => {
  const s = transcript([user('do it', -10), ask(-5)]);
  assert.equal(s.waiting, true);
  assert.equal(s.running, false);
});

test('once answered, it runs again', () => {
  const s = transcript([user('do it', -10), ask(-5), answer(-1)]);
  assert.equal(s.waiting, false);
  assert.equal(s.running, true);
});

test('a turn that ends asking for a decision waits on you', () => {
  const s = transcript([user('do it', -10), wrapUp(-5, true), wrapUpDone(-5), reply(-4)]);
  assert.equal(s.waiting, true);
  assert.equal(s.running, false);
});

test('your next message clears that wait', () => {
  const s = transcript([user('do it', -10), wrapUp(-5, true), wrapUpDone(-5), reply(-4), user('go ahead', -1)]);
  assert.equal(s.waiting, false);
  assert.equal(s.running, true);
});

test('a plain wrap-up does not wait on you', () => {
  const s = transcript([user('do it', -10), wrapUp(-5, false), wrapUpDone(-5), reply(-4)]);
  assert.equal(s.waiting, false);
});

const backgroundCall = (minutes, id) => ({ type: 'assistant', timestamp: at(minutes), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b-' + id, name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }] } });
const backgroundResult = (minutes, id, callId = 'b-' + id) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'Command running in background with ID: ' + id + '. Output is being written to: /tmp/x' }] } });
const startsBackground = (minutes, id) => [backgroundCall(minutes - 0.5, id), backgroundResult(minutes, id)];
const notification = (minutes, id) => user('<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n</task-notification>', minutes);

test('a turn that ends with work still running in the background shows as running', () => {
  const s = transcript([user('check it', -10), ...startsBackground(-9, 'bg1'), reply(-8)]);
  assert.equal(s.running, true);
  assert.equal(s.backgroundOnly, true);
});

test('when the background work reports back, the session runs its follow-up turn', () => {
  const s = transcript([user('check it', -10), ...startsBackground(-9, 'bg1'), reply(-8), notification(-2, 'bg1')]);
  assert.equal(s.running, true);
  assert.equal(s.backgroundOnly, false);
});

test('after the follow-up turn ends, nothing is left running', () => {
  const s = transcript([user('check it', -10), ...startsBackground(-9, 'bg1'), reply(-8), notification(-2, 'bg1'), reply(-1)]);
  assert.equal(s.running, false);
});

test('a report written as a queued command also finishes the background task', () => {
  const queued = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n</task-notification>' } };
  const s = transcript([user('check it', -10), ...startsBackground(-9, 'bg2'), reply(-8), queued]);
  assert.equal(s.backgroundOnly, false);
  assert.equal(s.running, false);
});

test('output that merely quotes the message does not start a background task', () => {
  const quoted = backgroundResult(-9, 'bg3', 'some-other-call');
  const s = transcript([user('show me the log', -10), quoted, reply(-8)]);
  assert.equal(s.running, false);
});

test('a preview server left running in the background is not work in progress', () => {
  const server = { type: 'assistant', timestamp: at(-9.5), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b-srv', name: 'Bash', input: { command: 'exec python3 -m http.server 8765', run_in_background: true } }] } };
  const s = transcript([user('preview it', -10), server, backgroundResult(-9, 'srv', 'b-srv'), reply(-8)]);
  assert.equal(s.running, false);
});

test('background work started over an hour ago no longer counts', () => {
  const s = transcript([user('check it', -120), ...startsBackground(-90, 'old'), reply(-89), user('next', -2), reply(-1)]);
  assert.equal(s.running, false);
});
