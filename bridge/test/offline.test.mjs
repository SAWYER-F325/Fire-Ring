import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-offline-'));
process.env.FIRE_RING_DATA_DIR = dir;
const PROXY = process.env.FIRE_RING_NETWORK_GUARD || 'http://127.0.0.1:8080';
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ proxy: { mode: 'off', url: PROXY } }));
const { currentRoute, getThroughEgress, downloadThroughEgress, EgressError } = await import('../src/egress.mjs');
const { readConfig } = await import('../src/config.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('offline mode opens no connection at all and keeps the saved proxy', async () => {
  const opened = [];
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { opened.push(args[0]); return original.apply(this, args); };
  try {
    assert.equal(currentRoute().offline, true);
    await assert.rejects(getThroughEgress('https://api.anthropic.com/api/oauth/usage'), EgressError);
    await assert.rejects(downloadThroughEgress('https://github.com/x', path.join(dir, 'f')), EgressError);
  } finally {
    net.Socket.prototype.connect = original;
  }
  assert.deepEqual(opened, []);
  assert.equal(readConfig().proxy.url, PROXY);
});
