import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-extra-providers-'));
const agyRoot = path.join(home, 'antigravity');
const cursorRoot = path.join(home, 'cursor');
const grokRoot = path.join(home, 'grok');
const grokDesktopRoot = path.join(home, 'grok-desktop');
const dataDir = path.join(home, 'data');

process.env.FIRE_RING_DATA_DIR = dataDir;
process.env.FIRE_RING_ANTIGRAVITY_HOME = agyRoot;
process.env.FIRE_RING_CURSOR_HOME = cursorRoot;
process.env.FIRE_RING_GROK_HOME = grokRoot;
process.env.FIRE_RING_GROK_DESKTOP_HOME = grokDesktopRoot;

fs.mkdirSync(agyRoot, { recursive: true });
fs.mkdirSync(cursorRoot, { recursive: true });
fs.mkdirSync(grokRoot, { recursive: true });
fs.mkdirSync(grokDesktopRoot, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const { readAntigravitySessions, readAntigravityQuota } = await import('../src/provider-antigravity.mjs');
const { readCursorSessions, readCursorQuota, recordCursorHook, clearCursorHooksForTest } = await import('../src/provider-cursor.mjs');
const { readGrokSessions, readGrokQuota, recordGrokHook, clearGrokHooksForTest } = await import('../src/provider-grok.mjs');
const {
  cursorHookState, connectCursorHooks, disconnectCursorHooks,
  grokHookState, connectGrokHooks, disconnectGrokHooks,
} = await import('../src/integrations.mjs');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Antigravity reads top-level conversations, ignores subagents and untitled CLI runs, detects waiting', () => {
  const dbPath = path.join(agyRoot, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      workspace_uris text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT 0,
      killed numeric NOT NULL DEFAULT 0,
      nesting_depth integer NOT NULL DEFAULT 0,
      parent_conversation_id text NOT NULL DEFAULT "",
      last_modified_time datetime NOT NULL
    );
  `);
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const insert = db.prepare(`INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('conv-run', 'Refactoring Build', 'CASCADE_RUN_STATUS_RUNNING', '', '["file:///Users/demo/my%20app"]', 1, 0, 0, '', iso(-10_000));
  insert.run('conv-wait', 'Confirm Plan', 'CASCADE_RUN_STATUS_IDLE', '', '["file:///Users/demo/web"]', 0, 0, 0, '', iso(-20_000));
  insert.run('conv-sub', 'Child Task', 'CASCADE_RUN_STATUS_RUNNING', '', '', 1, 0, 1, 'conv-run', iso(-5_000));
  insert.run('conv-headless', '', 'CASCADE_RUN_STATUS_IDLE', 'CORTEX_TRAJECTORY_SOURCE_CLI', '', 0, 0, 0, '', iso(-5_000));
  db.close();

  const logDir = path.join(agyRoot, 'brain', 'conv-wait', '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: { tool: 'ask_question' } }) + '\n');

  const sessions = readAntigravitySessions(now);
  assert.deepEqual(sessions.map((s) => s.id), ['conv-run', 'conv-wait']);
  assert.equal(sessions[0].running, true);
  assert.equal(sessions[0].cwd, '/Users/demo/my app');
  assert.equal(sessions[1].waiting, true);
  assert.equal(sessions[1].running, false);
});

test('Cursor reads local transcripts and merges real-time hook transitions', () => {
  clearCursorHooksForTest();
  const now = Date.now();
  const tDir = path.join(cursorRoot, 'projects', 'Users-demo-web', 'agent-transcripts', 'c-1');
  fs.mkdirSync(tDir, { recursive: true });
  fs.writeFileSync(path.join(tDir, 'c-1.jsonl'), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\n修复登录页样式\n</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '好了' }] } }),
  ].join('\n') + '\n');

  let list = readCursorSessions(now);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '修复登录页样式');
  assert.equal(list[0].running, false);

  recordCursorHook({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c-2', workspace_roots: [home], prompt: '加一个导出按钮' }, now);
  list = readCursorSessions(now + 500);
  const c2 = list.find((s) => s.id === 'c-2');
  assert.equal(c2.running, true);
  assert.equal(c2.title, '加一个导出按钮');
  assert.equal(c2.open.kind, 'url');

  recordCursorHook({ hook_event_name: 'stop', conversation_id: 'c-2' }, now + 2000);
  const c2Done = readCursorSessions(now + 2500).find((s) => s.id === 'c-2');
  assert.equal(c2Done.running, false);
});

test('Cursor hook connect preserves existing user hooks and disconnect removes only Fire Ring entries', () => {
  const hooksFile = path.join(cursorRoot, 'hooks.json');
  const existing = { version: 1, hooks: { stop: [{ command: '/usr/local/bin/other-tool --flag' }] } };
  fs.writeFileSync(hooksFile, JSON.stringify(existing, null, 2));

  assert.equal(cursorHookState(), 'off');
  assert.equal(connectCursorHooks(), 'on');
  const afterConnect = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.equal(afterConnect.hooks.stop.length, 2);
  assert.equal(afterConnect.hooks.stop[0].command, '/usr/local/bin/other-tool --flag');

  assert.equal(disconnectCursorHooks(), 'off');
  const afterDisconnect = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(afterDisconnect.hooks, existing.hooks);
});

test('Grok reads CLI updates.jsonl, deduplicates with Grok Desktop, and handles standalone hooks cleanly', () => {
  clearGrokHooksForTest();
  const now = Date.now();
  const cliDir = path.join(grokRoot, 'sessions', '%2Ftmp%2Fproj', 'grok-cli-1');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'summary.json'), JSON.stringify({
    info: { id: 'grok-cli-1', cwd: '/tmp/proj' },
    session_summary: '排查接口超时',
    updated_at: new Date(now - 5000).toISOString(),
  }));
  fs.writeFileSync(path.join(cliDir, 'updates.jsonl'), [
    JSON.stringify({ timestamp: Math.floor((now - 4000) / 1000), params: { update: { sessionUpdate: 'tool_call' } } }),
  ].join('\n') + '\n');

  // Desktop index referencing the same agentSessionId + a desktop-only session
  fs.writeFileSync(path.join(grokDesktopRoot, 'sessions_index.json'), JSON.stringify([
    { id: 'desk-link', title: '桌面端标题', agentSessionId: 'grok-cli-1', updatedAt: new Date(now - 3000).toISOString(), archived: false },
    { id: 'desk-only', title: '纯桌面会话', agentSessionId: null, updatedAt: new Date(now - 2000).toISOString(), archived: false },
  ]));
  const deskMsgDir = path.join(grokDesktopRoot, 'sessions', 'desk-only');
  fs.mkdirSync(deskMsgDir, { recursive: true });
  fs.writeFileSync(path.join(deskMsgDir, 'messages.json'), JSON.stringify([
    { id: 'm1', role: 'user', content: 'hi' },
  ]));

  const sessions = readGrokSessions(now);
  assert.equal(sessions.length, 2);
  const linked = sessions.find((s) => s.id === 'grok-cli-1');
  assert.equal(linked.title, '桌面端标题');
  assert.equal(linked.running, true);
  assert.equal(linked.open.value, 'com.grokapp.desktop');

  const deskOnly = sessions.find((s) => s.id === 'desk-only');
  assert.equal(deskOnly.running, true);

  recordGrokHook({ hook_event_name: 'Stop', session_id: 'grok-hook-only', cwd: '/tmp/proj' }, now);
  assert.equal(readGrokSessions(now + 1000).find((s) => s.id === 'grok-hook-only').running, false);

  // Standalone Grok hook file lifecycle
  const otherHook = path.join(grokRoot, 'hooks', 'other.json');
  fs.mkdirSync(path.dirname(otherHook), { recursive: true });
  fs.writeFileSync(otherHook, '{"hooks":{}}');
  assert.equal(grokHookState(), 'off');
  assert.equal(connectGrokHooks(), 'on');
  assert.equal(fs.existsSync(otherHook), true);
  assert.equal(disconnectGrokHooks(), 'off');
  assert.equal(fs.existsSync(otherHook), true);
});

test('Antigravity, Cursor, and Grok quota readers return local real-time usage and billing windows', () => {
  const now = Date.now();
  // Antigravity transcript token usage
  const agyLog = path.join(agyRoot, 'brain', 'conv-run', '.system_generated', 'logs');
  fs.mkdirSync(agyLog, { recursive: true });
  fs.writeFileSync(path.join(agyLog, 'transcript.jsonl'), JSON.stringify({
    type: 'PLANNER_RESPONSE', created_at: new Date(now - 60_000).toISOString(),
    model: 'gemini-4-neon', input_tokens: 1200, cache_read_tokens: 8000, output_tokens: 600,
  }) + '\n');
  const aq = readAntigravityQuota(now);
  assert.equal(aq.state, 'ok');
  assert.equal(aq.localUsage.fiveHour.messages, 1);
  assert.equal(aq.localUsage.fiveHour.totalTokens, 9800);

  // Cursor local membership from state.vscdb
  const cursorDbPath = path.join(home, 'cursor-state.vscdb');
  process.env.FIRE_RING_CURSOR_STORAGE_DB = cursorDbPath;
  const cdb = new DatabaseSync(cursorDbPath);
  cdb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
  cdb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/stripeMembershipType', 'pro');
  cdb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/stripeSubscriptionStatus', 'active');
  cdb.close();
  const cq = readCursorQuota(now);
  assert.equal(cq.state, 'ok');
  assert.equal(cq.plan, 'pro');

  // Grok desktop account_billing_cache.json + CLI usage.json
  fs.writeFileSync(path.join(grokDesktopRoot, 'account_billing_cache.json'), JSON.stringify({
    available: true,
    subscriptionTier: 'SuperGrok',
    creditUsagePercent: 12,
    remainingPercent: 88,
    resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
    products: [{ productId: 2, label: 'Grok Build', usedPercent: 12 }],
    fetchedAt: new Date(now - 60_000).toISOString(),
  }));
  const gUsageDir = path.join(grokRoot, 'sessions', '%2Ftmp%2Fproj', 'grok-cli-1');
  fs.writeFileSync(path.join(gUsageDir, 'usage.json'), JSON.stringify({
    updatedAt: new Date(now - 30_000).toISOString(),
    session: { primaryModelId: 'grok-4.7-build', turnCount: 2, totalTokens: 54000 },
    turns: [{ endedAt: new Date(now - 30_000).toISOString(), totalTokens: 54000, primaryModelId: 'grok-4.7-build' }],
  }));
  const gq = readGrokQuota(now);
  assert.equal(gq.state, 'ok');
  assert.equal(gq.plan, 'SuperGrok');
  assert.equal(gq.windows[0].leftPercent, 88);
  assert.equal(gq.extras[0].label, 'Grok Build');
  assert.equal(gq.localUsage.fiveHour.totalTokens, 54000);
});
