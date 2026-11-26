import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fire ring claude quota '));
const dataDir = path.join(home, 'Application Support', 'Fire Ring');
const claudeProjects = path.join(home, '.claude', 'projects', 'demo');
const planFile = path.join(home, 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');

process.env.HOME = home;
process.env.FIRE_RING_DATA_DIR = dataDir;
process.env.FIRE_RING_CLAUDE_PLAN_HISTORY = planFile;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(claudeProjects, { recursive: true });
fs.mkdirSync(path.dirname(planFile), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ providers: { claude: true }, quota: { claude: true } }));

const { desktopPlanQuota, localClaudeUsage, readClaudeQuota, quotaSummary } = await import('../src/quota.mjs');
const { STATUSLINE_FILE, save } = await import('../src/statusline.mjs');
const { createAlerts } = await import('../src/alerts.mjs');
const { normalizeAlerts } = await import('../src/config.mjs');
const { claudeStatusLineState, connectClaudeStatusLine, disconnectClaudeStatusLine } = await import('../src/integrations.mjs');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('desktopPlanQuota reads Claude Desktop plan-usage-history.json and computes trend', () => {
  const now = Date.now();
  const history = {
    version: 2,
    samples: [
      { t: now - 10 * 3_600_000, org: 'org-1', u: { sd: 100 } },
      { t: now - 6 * 3_600_000, org: 'org-1', u: { sd: 20, xu: 0 } },
      { t: now - 1 * 3_600_000, org: 'org-1', u: { fh: 35, sd: 70, xu: 5 } },
    ],
  };
  fs.writeFileSync(planFile, JSON.stringify(history));
  const q = desktopPlanQuota(now);
  assert.equal(q.state, 'ok');
  assert.equal(q.source, 'desktop');
  assert.deepEqual(q.windows.map((w) => [w.kind, w.leftPercent]), [['five_hour', 65], ['weekly', 30]]);
  assert.deepEqual(q.extraUsage, { usedPercent: 5 });
  assert.equal(q.trend.weeklyPerHour, 10);
  assert.equal(q.trend.estimatedHoursLeft, 3);
});

test('readClaudeQuota merges fresher desktop usage while keeping statusline resetsAt', () => {
  const now = Date.now();
  const resetSec = Math.floor(now / 1000) + 7200;
  save({ five_hour: { used_percentage: 20, resets_at: resetSec }, seven_day: { used_percentage: 40, resets_at: resetSec + 86400 } }, now - 2 * 3_600_000);
  fs.writeFileSync(planFile, JSON.stringify({
    version: 2,
    samples: [{ t: now - 5 * 60_000, org: 'org-1', u: { fh: 45, sd: 78, xu: 0 } }],
  }));
  const q = readClaudeQuota(now);
  assert.equal(q.source, 'merged');
  const five = q.windows.find((w) => w.kind === 'five_hour');
  const week = q.windows.find((w) => w.kind === 'weekly');
  assert.equal(five.leftPercent, 55);
  assert.equal(five.resetsAt, resetSec * 1000);
  assert.equal(week.leftPercent, 22);
  assert.equal(week.resetsAt, (resetSec + 86400) * 1000);

  const summary = quotaSummary(now);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, 'claude');
  assert.deepEqual(summary[0].windows.map((w) => [w.kind, w.leftPercent]), [['five_hour', 55], ['weekly', 22]]);
});

test('localClaudeUsage aggregates recent 5h and today assistant token counts', () => {
  const now = Date.now();
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now - 30 * 60_000).toISOString(),
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 } },
    }),
    JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      timestamp: new Date(now - 10 * 60_000).toISOString(),
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 9999 } },
    }),
  ];
  fs.writeFileSync(path.join(claudeProjects, 'session-1.jsonl'), lines.join('\n') + '\n');
  const usage = localClaudeUsage(now);
  assert.equal(usage.fiveHour.messages, 1);
  assert.equal(usage.fiveHour.totalTokens, 3000);
  assert.equal(usage.fiveHour.activeTokens, 1000);
  assert.equal(usage.model, 'claude-opus-5-5');
});

test('alerts fires once when Claude quota drops below claudeLow threshold', () => {
  let t = 1_800_000_000_000;
  const claude = { state: 'ok', windows: [{ kind: 'weekly', leftPercent: 40, resetsAt: null, reset: false }] };
  const cfg = { alerts: normalizeAlerts({ claudeLow: 20 }), providers: { claude: true, codex: false, dsh: false } };
  const a = createAlerts({ now: () => t, config: () => cfg, claudeQuota: () => claude });
  a.observe([]);
  claude.windows[0].leftPercent = 18;
  t += 61_000; a.observe([]);
  t += 61_000; a.observe([]);
  assert.equal(a.latest().events.length, 1);
  assert.match(a.latest().events[0].title, /Claude 每周额度剩 18%/);
  claude.windows[0].leftPercent = 95;
  t += 61_000; a.observe([]);
  claude.windows[0].leftPercent = 12;
  t += 61_000; a.observe([]);
  assert.equal(a.latest().events.length, 2);
});

test('connectClaudeStatusLine chains existing statusLine with spaces in path and restores cleanly', () => {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const marker = path.join(home, 'prev-seen.txt');
  const prevScript = path.join(home, 'my prev statusline.sh');
  fs.writeFileSync(prevScript, `#!/bin/sh\ncat > '${marker}'\necho "CUSTOM OK"\n`, { mode: 0o755 });
  const original = { type: 'command', command: `'${prevScript}'` };
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus', statusLine: original }, null, 2));

  assert.equal(claudeStatusLineState(), 'other');
  assert.equal(connectClaudeStatusLine(), 'on');

  const updated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.match(updated.statusLine.command, /claude-statusline-chain\.sh/);
  if (fs.existsSync(STATUSLINE_FILE)) fs.rmSync(STATUSLINE_FILE);

  const payload = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 27, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  });
  const out = execFileSync('/bin/sh', ['-c', updated.statusLine.command], { input: payload }).toString().trim();
  assert.equal(out, 'CUSTOM OK');
  assert.equal(fs.readFileSync(marker, 'utf8'), payload);
  const saved = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
  assert.equal(saved.rate_limits.five_hour.used_percentage, 27);

  assert.equal(disconnectClaudeStatusLine(), 'other');
  const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(restored.statusLine, original);
  assert.equal(restored.model, 'opus');
});
