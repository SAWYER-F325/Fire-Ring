import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-egress-test-'));
process.env.FIRE_RING_DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { writeConfig } = await import('../src/config.mjs');
const { getThroughEgress, EgressError } = await import('../src/egress.mjs');

// 维护者本机加锁运行时只能用锁定的地址；其他人用一个示例端口。
const PROXY = process.env.FIRE_RING_NETWORK_GUARD || 'http://127.0.0.1:8080';
const PROXY_PORT = Number(new URL(PROXY).port);

test('a configured proxy supplies the TLS socket instead of a default direct connection', async (t) => {
  writeConfig({ proxy: { mode: 'custom', url: PROXY } });
  const tunnelSocket = {};
  const stoppedAtTunnel = new Error('Stopped at the supplied tunnel; no network traffic');
  let tunnelConnections = 0;
  let directConnections = 0;

  t.mock.method(http, 'request', (options) => {
    assert.equal(options.host, '127.0.0.1');
    assert.equal(options.port, PROXY_PORT);
    assert.equal(options.method, 'CONNECT');
    assert.equal(options.path, 'example.invalid:443');
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('connect', { statusCode: 200 }, tunnelSocket));
    return request;
  });
  t.mock.method(https.Agent.prototype, 'createConnection', () => {
    directConnections += 1;
    throw new Error('A default HTTPS connection would bypass the proxy');
  });
  t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.socket, tunnelSocket);
    tunnelConnections += 1;
    throw stoppedAtTunnel;
  });

  await assert.rejects(getThroughEgress('https://example.invalid/'), (error) => error === stoppedAtTunnel);
  assert.equal(tunnelConnections, 1);
  assert.equal(directConnections, 0);
});

test('an unavailable custom proxy fails before any HTTPS connection is attempted', async (t) => {
  writeConfig({ proxy: { mode: 'custom', url: PROXY } });
  let httpsRequests = 0;
  t.mock.method(http, 'request', () => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return request;
  });
  t.mock.method(https, 'request', () => {
    httpsRequests += 1;
    throw new Error('HTTPS must not run after proxy failure');
  });

  await assert.rejects(getThroughEgress('https://example.invalid/'), EgressError);
  assert.equal(httpsRequests, 0);
});


test('a locked build refuses proxy changes while keeping other settings editable', (t) => {
  const locked = process.env.FIRE_RING_NETWORK_GUARD;
  if (!locked) {
    t.skip('Only runs under a launcher that sets FIRE_RING_NETWORK_GUARD');
    return;
  }
  const quoted = new RegExp(locked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  assert.throws(() => writeConfig({ proxy: { mode: 'direct', url: '' } }), quoted);
  assert.throws(() => writeConfig({ proxy: { mode: 'custom', url: 'http://127.0.0.1:1' } }), quoted);
  assert.equal(writeConfig({ updates: { autoCheck: false } }).proxy.url, locked);
  assert.equal(writeConfig({ proxy: { mode: 'off' } }).proxy.mode, 'off');
  assert.equal(writeConfig({ proxy: { mode: 'off' } }).proxy.url, locked);
  assert.throws(() => writeConfig({ proxy: { mode: 'system' } }), quoted);
  assert.equal(writeConfig({ proxy: { mode: 'custom' } }).proxy.mode, 'custom');
});

for (const { url, authority, hostHeader } of [
  { url: 'https://example.invalid/file', authority: 'example.invalid:443', hostHeader: 'example.invalid' },
  { url: 'https://example.invalid:8443/file', authority: 'example.invalid:8443', hostHeader: 'example.invalid:8443' },
]) {
  test('a tunneled HTTPS request uses the correct authority for ' + authority, async (t) => {
    writeConfig({ proxy: { mode: 'custom', url: PROXY } });
    const originalRequest = https.request;
    const stopped = new Error('Inspected the HTTP header without connecting');
    let observedHost;
    t.mock.method(http, 'request', (options) => {
      assert.equal(options.path, authority);
      assert.equal(options.headers.Host, authority);
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => request.emit('connect', { statusCode: 200 }, {}));
      return request;
    });
    t.mock.method(https.Agent.prototype, 'createConnection', () => {
      throw new Error('A default connection would bypass the supplied tunnel');
    });
    t.mock.method(https, 'request', (options) => {
      const socket = new net.Socket();
      const request = originalRequest({ ...options, createConnection: () => socket });
      request.on('error', () => {});
      observedHost = request.getHeader('host');
      request.destroy();
      socket.destroy();
      throw stopped;
    });
    await assert.rejects(getThroughEgress(url), (error) => error === stopped);
    assert.equal(observedHost, hostHeader);
  });
}
