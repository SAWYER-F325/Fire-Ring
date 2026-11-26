// Where Fire Ring keeps its files, and the settings the user can change.
//
// Everything lives in one folder, ~/Library/Application Support/Fire Ring:
//   token         lets the app's own pages talk to the bridge
//   state.json    notch switches and which completions were cleared
//   config.json   network and update settings (this file's concern)
//   updates/      downloaded updates waiting to be installed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.FIRE_RING_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Fire Ring');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
export const UPDATES_DIR = path.join(DATA_DIR, 'updates');

/** The running version, passed in by the app; "0.0.0-dev" when run by hand. */
export const VERSION = process.env.FIRE_RING_VERSION || readRepoVersion() || '0.0.0-dev';
/** "owner/name" of the GitHub repository releases come from; empty until set. */
export const UPDATE_REPO = (process.env.FIRE_RING_REPO || '').trim();
/** Where the running app bundle is, so an update knows what to replace. */
export const APP_PATH = process.env.FIRE_RING_APP_PATH || '';

function readRepoVersion() {
  try {
    const file = new URL('../../VERSION', import.meta.url);
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// proxy.mode:
//   system   use the HTTP(S) proxy set in macOS network settings, if any
//   custom   use proxy.url and nothing else, with no fallback
//   direct   connect without a proxy
//   off      no network at all: nothing leaves this Mac
// A build can lock the bridge to one proxy (FIRE_RING_NETWORK_GUARD=http://host:port,
// set by a launcher that also sandboxes it). Then the route cannot be changed in
// Settings, only switched off. Ordinary builds leave it unset.
function lockedProxy() {
  const url = (process.env.FIRE_RING_NETWORK_GUARD || '').trim();
  return url && validProxyUrl(url) ? { mode: 'custom', url } : null;
}

// Which tools Fire Ring watches. Nothing is connected until the user connects
// it in Settings; a tool that is not connected is neither read nor shown.
export const PROVIDER_IDS = ['claude', 'codex', 'dsh', 'antigravity', 'cursor', 'grok'];

const DEFAULTS = {
  proxy: { mode: 'system', url: '' },
  providers: { claude: false, codex: false, dsh: false, antigravity: false, cursor: false, grok: false },
  // Which limits the menu-bar panel shows. Claude's desktop app gives no running
  // percentages, so it is off unless the user turns it on.
  quota: { claude: false, codex: true, dsh: false },
  updates: { autoCheck: true },
  onboarded: false,
  // Whether to ask about launching at login: 'ask' until the user picks
  // "以后不再提醒", then 'never'.
  loginPrompt: 'ask',
  // Colour mode of the menu-bar panel and Settings: 'dark' (default), 'light',
  // or 'system' to follow macOS. The notch itself is always dark.
  theme: 'dark',
};

// 提示音：Fire Ring 原创音效（随 App 打包）和 macOS 自带的提示音。
export const SOUND_IDS = [
  'fr-rise', 'fr-arp', 'fr-crystal', 'fr-drop', 'fr-kalimba', 'fr-chord', 'fr-spark',
  'fr-call', 'fr-ask', 'fr-door', 'fr-knock', 'fr-pulse', 'fr-ember',
  ...['Glass', 'Hero', 'Ping', 'Pop', 'Tink', 'Purr', 'Submarine', 'Blow', 'Bottle', 'Frog', 'Funk', 'Morse', 'Sosumi', 'Basso'].map((n) => 'mac-' + n),
  'none',
];
const REMIND_MINUTES = [0, 5, 10, 30];
const CODEX_LOW = [0, 10, 20, 30];

// 刘海之外的提醒：提示音、系统通知、再次提醒、暂停、按工具开关和额度提醒。
export function normalizeAlerts(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sounds = r.sounds && typeof r.sounds === 'object' ? r.sounds : {};
  const notify = r.notify && typeof r.notify === 'object' ? r.notify : {};
  const tools = r.tools && typeof r.tools === 'object' ? r.tools : {};
  const dsLow = r.dsLow && typeof r.dsLow === 'object' ? r.dsLow : {};
  const volume = Number(r.volume);
  const amount = Number(dsLow.amount);
  const until = Number(r.pausedUntil);
  return {
    sounds: {
      wait: SOUND_IDS.includes(sounds.wait) ? sounds.wait : 'fr-ask',
      done: SOUND_IDS.includes(sounds.done) ? sounds.done : 'fr-arp',
    },
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : 60,
    notify: {
      wait: notify.wait !== false,
      done: notify.done === true,
      title: notify.title !== false,
    },
    remind: REMIND_MINUTES.includes(Number(r.remind)) ? Number(r.remind) : 10,
    pausedUntil: Number.isFinite(until) && until > 0 ? until : 0,
    tools: Object.fromEntries(PROVIDER_IDS.map((id) => {
      const t = tools[id] && typeof tools[id] === 'object' ? tools[id] : {};
      return [id, { wait: t.wait !== false, done: t.done !== false }];
    })),
    codexLow: CODEX_LOW.includes(Number(r.codexLow)) ? Number(r.codexLow) : 20,
    dsLow: { on: dsLow.on !== false, amount: Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : 10 },
  };
}

const PROXY_URL = /^http:\/\/[^\s/:@]+(:\d{1,5})?\/?$/;

export function validProxyUrl(url) {
  if (typeof url !== 'string' || !PROXY_URL.test(url)) return false;
  const port = Number((url.match(/:(\d{1,5})\/?$/) || [])[1] || 80);
  return port > 0 && port < 65536;
}

let cache = null;

export function readConfig() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* first run, or an unreadable file: defaults */
  }
  const proxy = raw.proxy && typeof raw.proxy === 'object' ? raw.proxy : {};
  const mode = ['system', 'custom', 'direct', 'off'].includes(proxy.mode) ? proxy.mode : DEFAULTS.proxy.mode;
  cache = {
    proxy: lockedProxy()
      ? { ...lockedProxy(), mode: mode === 'off' ? 'off' : 'custom' }
      : { mode, url: typeof proxy.url === 'string' ? proxy.url.trim() : '' },
    updates: { autoCheck: !(raw.updates && raw.updates.autoCheck === false) },
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, Boolean(raw.providers && raw.providers[id] === true)])),
    quota: {
      claude: Boolean(raw.quota && raw.quota.claude === true),
      codex: !(raw.quota && raw.quota.codex === false),
      dsh: Boolean(raw.quota && raw.quota.dsh === true),
    },
    onboarded: raw.onboarded === true,
    loginPrompt: raw.loginPrompt === 'never' ? 'never' : 'ask',
    theme: ['dark', 'light', 'system'].includes(raw.theme) ? raw.theme : 'dark',
    alerts: normalizeAlerts(raw.alerts),
  };
  return cache;
}

export function writeConfig(patch) {
  const current = readConfig();
  const locked = lockedProxy();
  if (locked && patch.proxy) {
    const requested = { ...current.proxy, ...patch.proxy };
    if (!['custom', 'off'].includes(requested.mode) || requested.url !== locked.url) {
      throw new Error('网络保护已锁定 ' + locked.url + '，修改出口需要用户明确授权');
    }
  }
  const next = {
    ...current,
    ...patch,
    proxy: { ...current.proxy, ...(patch.proxy || {}) },
    updates: { ...current.updates, ...(patch.updates || {}) },
    providers: { ...current.providers, ...(patch.providers || {}) },
    quota: { ...current.quota, ...(patch.quota || {}) },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  cache = null;
  return readConfig();
}

/** 「重置设置」：外观、菜单栏额度和提醒恢复默认；连接、网络和引导状态不动。 */
export function resetPreferences() {
  return writeConfig({ theme: DEFAULTS.theme, quota: { ...DEFAULTS.quota }, alerts: normalizeAlerts({}) });
}

/** Forget the cached copy, e.g. after another process changed the file. */
export function reloadConfig() {
  cache = null;
}
