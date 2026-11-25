import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDiagnostics, redact } from '../src/diagnostics.mjs';

test('打码：API Key、Bearer、令牌和授权参数', () => {
  const text = redact([
    'key sk-abcdef1234567890XYZ saved',
    'Authorization: Bearer eyJhbGciOi.abc.def',
    'token=abc123 cookie: sessionid=zzz',
    'https://example.com/cb?code=SECRET&state=XYZ&ok=1',
    'session 3f9011b3-1234-4abc-8def-0123456789ab finished',
  ].join('\n'));
  assert.doesNotMatch(text, /abcdef1234567890XYZ|eyJhbGciOi|abc123|sessionid=zzz|SECRET|XYZ&|0123456789ab/);
  assert.match(text, /sk-\*\*\*/);
  assert.match(text, /\?code=\*\*\*&state=\*\*\*&ok=1/);
  assert.match(text, /3f9011b3-…/);
});

test('诊断信息带上设置和日志末尾，并且已经打码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-diag-'));
  const log = path.join(dir, 'bridge.log');
  fs.writeFileSync(log, Array.from({ length: 600 }, (_, i) => 'line ' + i).join('\n') + '\n[deepseek] key sk-SHOULDNOTLEAK123456\n');
  const text = buildDiagnostics({
    version: '9.9.9',
    route: { label: '127.0.0.1:8080' },
    tools: [{ id: 'codex', found: true, connected: true }],
    config: { theme: 'dark', alerts: { volume: 60 } },
    notch: { fullscreen: 'hide' },
    deepseek: { hasKey: true, state: 'ok' },
    update: { phase: 'latest' },
  }, { logFile: log, now: new Date('2026-11-18T00:00:00Z') });
  assert.match(text, /# Fire Ring 诊断信息/);
  assert.match(text, /"version": "9.9.9"/);
  assert.match(text, /"hasKey": true/);
  assert.match(text, /"state": "ok"/);
  assert.match(text, /line 599/);
  assert.doesNotMatch(text, /line 100\b/);
  assert.doesNotMatch(text, /SHOULDNOTLEAK/);
});

test('读不到日志时照样生成', () => {
  const text = buildDiagnostics({ version: '1' }, { logFile: '/nonexistent/bridge.log' });
  assert.match(text, /读不到日志/);
});
