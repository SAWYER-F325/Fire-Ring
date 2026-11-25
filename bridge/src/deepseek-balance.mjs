// DeepSeek account balance, from DeepSeek's documented endpoint
// (GET https://api.deepseek.com/user/balance) with the user's own API key.
//
// The key is pasted by the user in Settings and kept only in the login
// keychain (written through stdin, never on a command line). It travels only to
// api.deepseek.com along the configured route (egress.mjs) and never appears in
// logs or in anything the bridge returns.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { EgressError, currentRoute, getThroughEgress } from './egress.mjs';

const KEYCHAIN_SERVICE = 'Fire Ring DeepSeek API Key';
const KEYCHAIN_ACCOUNT = 'default';
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const REFRESH_MS = 10 * 60_000;
const PAUSE_MS = 15 * 60_000;            // after a 429 without Retry-After, or a network failure
const STALE_KEEP_MS = 2 * 60 * 60_000;   // an older reading may be shown, marked as old, this long
const KEY_SHAPE = /^sk-[A-Za-z0-9_-]{16,200}$/;

let reading = { state: 'loading', balances: [], observedAt: null };
let fetchedAt = 0;
let inflight = null;
let pausedUntil = 0;
let lastGood = null;
// Past readings of the main balance, { at, total, currency }, kept a week, so
// the panel can show what was spent today and a 24-hour curve. Local only.
let history = [];
const HISTORY_KEEP_MS = 8 * 24 * 60 * 60_000;

// Survives restarts: the last good numbers and any pause. Never the key.
const STATE_FILE = path.join(DATA_DIR, 'deepseek-balance.json');
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (Number(saved.pausedUntil) > Date.now()) pausedUntil = Number(saved.pausedUntil);
  if (saved.lastGood && Number(saved.lastGood.observedAt)) lastGood = saved.lastGood;
  if (Array.isArray(saved.history)) history = saved.history.filter((h) => Number(h.at) && Number.isFinite(h.total));
  // Until the first query of this run answers, show the last one (with its time).
  if (lastGood && Date.now() - lastGood.observedAt < STALE_KEEP_MS) reading = { ...lastGood };
} catch {
  /* nothing saved yet */
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pausedUntil, lastGood, history }));
  } catch {
    /* the in-memory copy still works */
  }
}

const log = (text) => console.log('[deepseek] ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z ' + text);

function run(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
    child.stdin.end(input || '');
  });
}

function readKey() {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: 30_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
  });
}

export function validKeyShape(key) {
  return typeof key === 'string' && KEY_SHAPE.test(key.trim());
}

/** Saves the key in the keychain, as hex through stdin. */
export async function saveKey(key) {
  const hex = Buffer.from(key.trim(), 'utf8').toString('hex');
  const code = await run('/usr/bin/security', ['-i'],
    `add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`);
  return code === 0;
}

function remember(main, at) {
  if (!main) return;
  history = history.filter((h) => at - h.at < HISTORY_KEEP_MS && h.currency === main.currency);
  history.push({ at, total: main.total, currency: main.currency });
}

/**
 * What the readings say about spending: a drop between two readings is money
 * spent, a rise is a top-up (not counted). Plus the last 24 hours as points.
 */
export function spendingFrom(points, now = Date.now()) {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = (from) => {
    let spent = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].at < from) continue;
      const drop = sorted[i - 1].total - sorted[i].total;
      if (drop > 0) spent += drop;
    }
    return Math.round(spent * 100) / 100;
  };
  const day = sorted.filter((p) => now - p.at <= 24 * 60 * 60_000).map((p) => ({ at: p.at, total: p.total }));
  return {
    currency: sorted.length ? sorted[sorted.length - 1].currency : null,
    today: since(midnight.getTime()),
    week: since(now - 7 * 24 * 60 * 60_000),
    trackedSince: sorted.length ? sorted[0].at : null,
    day,
  };
}

export async function deleteKey() {
  await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
  lastGood = null;
  history = [];
  reading = { state: 'no_key', balances: [], observedAt: null };
  persist();
}

/** Whether a key is saved; reads only the item's attributes, not the key. */
export function hasKey() {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { timeout: 10_000 }, (error) => resolve(!error));
  });
}

/** DeepSeek's answer as the panel's balances: [{ currency, total, granted, toppedUp }]. */
export function balancesFrom(body) {
  const rows = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
  return rows
    .map((row) => ({
      currency: String(row.currency || ''),
      total: Number(row.total_balance),
      granted: Number(row.granted_balance),
      toppedUp: Number(row.topped_up_balance),
    }))
    .filter((row) => row.currency && Number.isFinite(row.total));
}

function staleOr(state) {
  if (lastGood && Date.now() - lastGood.observedAt < STALE_KEEP_MS) return { ...lastGood, stale: state };
  return { state, balances: [], observedAt: null };
}

async function refresh() {
  if (currentRoute().offline) {
    reading = { state: 'offline', balances: [], observedAt: null };
    return;
  }
  if (Date.now() < pausedUntil) return;
  const key = await readKey();
  if (!key) {
    reading = { state: 'no_key', balances: [], observedAt: null };
    return;
  }
  try {
    const response = await getThroughEgress(BALANCE_URL, {
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
      'User-Agent': 'FireRing',
    });
    if (response.status === 401) {
      log('DeepSeek answered 401: the saved API key was not accepted');
      reading = { state: 'bad_key', balances: [], observedAt: null };
      return;
    }
    if (response.status === 429) {
      const wait = Number(response.headers && response.headers['retry-after']) * 1000;
      pausedUntil = Date.now() + Math.max(wait > 0 ? wait : 0, PAUSE_MS);
      persist();
      log('DeepSeek asked to slow down; next try at ' + new Date(pausedUntil).toISOString());
      reading = staleOr('rate_limited');
      return;
    }
    if (response.status !== 200) throw new Error('HTTP ' + response.status);
    const body = JSON.parse(response.body);
    const balances = balancesFrom(body);
    reading = {
      state: balances.length ? 'ok' : 'unknown',
      available: body.is_available !== false,
      balances,
      observedAt: Date.now(),
    };
    if (reading.state === 'ok') {
      lastGood = reading;
      remember(balances[0], reading.observedAt);
      persist();
    }
  } catch (error) {
    if (error instanceof EgressError) {
      pausedUntil = Date.now() + PAUSE_MS;
      log('network unavailable, paused: ' + error.message);
      reading = { ...staleOr('egress_down'), detail: error.message };
    } else {
      log('reading the balance failed: ' + error.message);
      reading = staleOr('error');
    }
  }
}

/** The latest reading at once; a fresh one is fetched in the background every 10 minutes. */
export function deepseekBalance(now = Date.now()) {
  if (!inflight && now - fetchedAt > REFRESH_MS) {
    fetchedAt = now;
    inflight = refresh().finally(() => { inflight = null; });
  }
  return reading.balances && reading.balances.length ? { ...reading, spending: spendingFrom(history, now) } : reading;
}

/** The latest reading, without asking DeepSeek. */
export function lastBalance() {
  return reading;
}

/** Asks again now (after saving a key, or on request). Resolves the new reading. */
let manualAt = 0;
export function refreshBalanceNow({ keepPause = true } = {}) {
  // A second click within 20 seconds gets the reading just made.
  if (Date.now() - manualAt < 20_000 && !inflight) return Promise.resolve(reading);
  manualAt = Date.now();
  if (!keepPause) pausedUntil = 0;
  fetchedAt = Date.now();
  const run = (inflight || Promise.resolve()).then(() => refresh());
  inflight = run.finally(() => { inflight = null; });
  return run.then(() => reading);
}

export const _test = { KEY_SHAPE };
