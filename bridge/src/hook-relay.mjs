#!/usr/bin/env node
// Lightweight fail-open hook relay for Cursor and Grok.
// Reads the hook JSON payload from stdin, forwards it to the local Fire Ring
// bridge on 127.0.0.1, prints "{}" on stdout and always exits 0 so the host
// editor/CLI is never blocked even when Fire Ring is not running.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const providerIdx = process.argv.indexOf('--provider');
const provider = providerIdx >= 0 ? String(process.argv[providerIdx + 1] || '').trim() : '';
const port = Number(process.env.FIRE_RING_PORT ?? 47821);
const dataDir = process.env.FIRE_RING_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Fire Ring');

function readStdin(maxBytes = 64 * 1024, timeoutMs = 400) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}

function readToken() {
  try {
    return fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function post(body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/hook?provider=' + encodeURIComponent(provider),
      method: 'POST',
      timeout: 500,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Bridge-Token': readToken(),
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end(body);
  });
}

if (provider) {
  const raw = (await readStdin()).trim();
  if (raw) {
    try {
      // Ensure valid JSON before relaying.
      JSON.parse(raw);
      await post(raw);
    } catch {
      /* ignore malformed input */
    }
  }
}

process.stdout.write('{}\n');
