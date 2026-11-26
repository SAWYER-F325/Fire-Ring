// Which AI tools are on this Mac, and connecting Fire Ring to DeepSeek Harness.
//
// Claude Code and Codex need nothing installed: Fire Ring reads the files they
// already write. DeepSeek Harness gets a small plugin (integrations/
// deepseek-harness) so its desktop window can report questions waiting on you
// and open a conversation when you click it in the notch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';

const HOME = os.homedir();
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const DSH_HOME = path.join(HOME, '.dsh');
const DSH_PROFILE = path.join(DSH_HOME, 'profiles', 'desktop');
const PLUGIN_NAME = '@local/dsh-sessions';
// Kept inside DeepSeek Harness's own folder: no spaces in the path (its package
// manager links by path), and it survives Fire Ring updates.
const PLUGIN_HOME = path.join(DSH_HOME, 'plugins', 'fire-ring');

const agyHome = () => process.env.FIRE_RING_ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini', 'antigravity');
const cursorHome = () => process.env.FIRE_RING_CURSOR_HOME || path.join(os.homedir(), '.cursor');
const grokHome = () => process.env.FIRE_RING_GROK_HOME || path.join(os.homedir(), '.grok');
const grokDesktopHome = () => process.env.FIRE_RING_GROK_DESKTOP_HOME
  || path.join(os.homedir(), 'Library', 'Application Support', 'com.grokapp.grok-app');

const HOOK_RELAY = fileURLToPath(new URL('./hook-relay.mjs', import.meta.url));
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hookCommand = (provider) => `${shellQuote(process.execPath)} ${shellQuote(HOOK_RELAY)} --provider ${provider}`;
const isOurHook = (cmd, provider) => typeof cmd === 'string' && cmd.includes('hook-relay.mjs') && cmd.includes('--provider ' + provider);

const CURSOR_EVENTS = [
  'beforeSubmitPrompt', 'afterAgentThought', 'beforeShellExecution', 'afterShellExecution',
  'beforeMCPExecution', 'afterMCPExecution', 'afterFileEdit', 'afterAgentResponse', 'stop',
];
const GROK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'SessionEnd',
];

export function cursorHookState() {
  const file = path.join(cursorHome(), 'hooks.json');
  const data = readJson(file);
  const hooks = data && data.hooks && typeof data.hooks === 'object' ? data.hooks : null;
  if (!hooks) return 'off';
  const has = Object.values(hooks).some((list) => Array.isArray(list) && list.some((e) => isOurHook(e && e.command, 'cursor')));
  return has ? 'on' : 'off';
}

export function connectCursorHooks() {
  const dir = cursorHome();
  const file = path.join(dir, 'hooks.json');
  fs.mkdirSync(dir, { recursive: true });
  const existed = exists(file);
  const data = readJson(file) || { version: 1, hooks: {} };
  if (existed && !exists(file + '.fire-ring-backup')) {
    fs.copyFileSync(file, file + '.fire-ring-backup');
  }
  data.version = data.version || 1;
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  const cmd = hookCommand('cursor');
  for (const ev of CURSOR_EVENTS) {
    const list = Array.isArray(data.hooks[ev]) ? data.hooks[ev] : [];
    if (!list.some((e) => isOurHook(e && e.command, 'cursor'))) {
      list.push({ command: cmd });
    }
    data.hooks[ev] = list;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log('[setup] Cursor hooks connected');
  return cursorHookState();
}

export function disconnectCursorHooks() {
  const file = path.join(cursorHome(), 'hooks.json');
  const data = readJson(file);
  if (data && data.hooks && typeof data.hooks === 'object') {
    for (const [ev, list] of Object.entries(data.hooks)) {
      if (!Array.isArray(list)) continue;
      const filtered = list.filter((e) => !isOurHook(e && e.command, 'cursor'));
      if (filtered.length) data.hooks[ev] = filtered;
      else delete data.hooks[ev];
    }
    if (Object.keys(data.hooks).length === 0 && !exists(file + '.fire-ring-backup')) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    }
  }
  console.log('[setup] Cursor hooks removed');
  return cursorHookState();
}

export function grokHookState() {
  return exists(path.join(grokHome(), 'hooks', 'fire-ring.json')) ? 'on' : 'off';
}

export function connectGrokHooks() {
  const dir = path.join(grokHome(), 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const cmd = hookCommand('grok');
  const hooks = {};
  for (const ev of GROK_EVENTS) {
    const entry = { hooks: [{ type: 'command', command: cmd }] };
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification'].includes(ev)) entry.matcher = '*';
    hooks[ev] = [entry];
  }
  fs.writeFileSync(path.join(dir, 'fire-ring.json'), JSON.stringify({ hooks }, null, 2) + '\n');
  console.log('[setup] Grok hooks connected');
  return grokHookState();
}

export function disconnectGrokHooks() {
  fs.rmSync(path.join(grokHome(), 'hooks', 'fire-ring.json'), { force: true });
  console.log('[setup] Grok hooks removed');
  return grokHookState();
}

/** The plugin as shipped: inside the app, or in the repository when run by hand. */
function pluginSource() {
  const candidates = [
    process.env.FIRE_RING_RESOURCES && path.join(process.env.FIRE_RING_RESOURCES, 'integrations', 'deepseek-harness'),
    fileURLToPath(new URL('../../integrations/deepseek-harness', import.meta.url)),
  ].filter(Boolean);
  return candidates.find((p) => exists(path.join(p, 'package.json'))) || null;
}

const appInstalled = (name) => exists(path.join('/Applications', name)) || exists(path.join(HOME, 'Applications', name));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dshPluginState() {
  if (!exists(DSH_PROFILE)) return 'no_profile';
  const pkg = readJson(path.join(DSH_PROFILE, 'package.json')) || {};
  const dep = pkg.dependencies && pkg.dependencies[PLUGIN_NAME];
  const bundled = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes(PLUGIN_NAME);
  if (!dep || !bundled) return 'off';
  const linked = path.join(DSH_PROFILE, 'node_modules', '@local', 'dsh-sessions');
  return exists(path.join(linked, 'package.json')) ? 'on' : 'broken';
}

/** What the setup screen shows about each tool: installed here, and connected to Fire Ring. */
export function detectTools() {
  const { providers } = readConfig();
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      found: exists(path.join(HOME, '.claude', 'projects')) || exists(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')),
      app: appInstalled('Claude.app'),
      connected: providers.claude,
    },
    {
      id: 'codex',
      name: 'Codex',
      found: exists(path.join(CODEX_HOME, 'sessions')),
      app: appInstalled('Codex.app'),
      connected: providers.codex,
    },
    {
      id: 'dsh',
      name: 'DeepSeek Harness',
      found: exists(DSH_HOME),
      app: appInstalled('DeepSeek Harness.app'),
      plugin: dshPluginState(),
      pluginLocation: PLUGIN_HOME,
      connected: providers.dsh,
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      found: exists(path.join(agyHome(), 'conversation_summaries.db')) || appInstalled('Antigravity.app'),
      app: appInstalled('Antigravity.app'),
      connected: providers.antigravity,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      found: exists(cursorHome()) || appInstalled('Cursor.app'),
      app: appInstalled('Cursor.app'),
      hook: cursorHookState(),
      connected: providers.cursor,
    },
    {
      id: 'grok',
      name: 'Grok',
      found: exists(path.join(grokHome(), 'sessions')) || exists(path.join(grokDesktopHome(), 'sessions_index.json')) || appInstalled('Grok.app'),
      app: appInstalled('Grok.app'),
      hook: grokHookState(),
      connected: providers.grok,
    },
  ];
}

// pnpm-lock.yaml keeps the profile's own dependencies under `importers: .:`.
// Only that one entry is touched; anything unexpected leaves the file alone.
function lockWithPlugin(text, target) {
  const relative = path.relative(DSH_PROFILE, target);
  const entry = `      '${PLUGIN_NAME}':\n        specifier: link:${target}\n        version: link:${relative}\n`;
  const existing = new RegExp(`      '${PLUGIN_NAME.replace('/', '\\/')}':\\n        specifier: [^\\n]*\\n        version: [^\\n]*\\n`);
  if (existing.test(text)) return text.replace(existing, entry);
  if (text.includes('\n  .:\n    dependencies:\n')) return text.replace('\n  .:\n    dependencies:\n', '\n  .:\n    dependencies:\n' + entry);
  if (text.includes('\n  .: {}\n')) return text.replace('\n  .: {}\n', '\n  .:\n    dependencies:\n' + entry);
  return null;
}

function lockWithoutPlugin(text) {
  const existing = new RegExp(`      '${PLUGIN_NAME.replace('/', '\\/')}':\\n        specifier: [^\\n]*\\n        version: [^\\n]*\\n`);
  let next = text.replace(existing, '');
  next = next.replace(/\n {2}\.:\n {4}dependencies:\n(?! {6})/, '\n  .: {}\n');
  return next;
}

/**
 * Fire Ring 更新后，DeepSeek Harness 里的插件还是旧的：已连接时换成 App 带的新版。
 * 只换插件自己的文件，DeepSeek Harness 的配置不动。重启 DeepSeek Harness 后生效。
 */
export function syncDeepSeekPlugin() {
  const source = pluginSource();
  if (!source || !exists(path.join(PLUGIN_HOME, 'package.json')) || dshPluginState() !== 'on') return false;
  const same = (name) => {
    try {
      return fs.readFileSync(path.join(source, name)).equals(fs.readFileSync(path.join(PLUGIN_HOME, name)));
    } catch {
      return false;
    }
  };
  if (['client.js', 'index.js', 'package.json', 'cordis.patch.yml'].every(same)) return false;
  fs.cpSync(source, PLUGIN_HOME, { recursive: true, force: true });
  console.log('[setup] DeepSeek Harness plugin updated; restart DeepSeek Harness to load it');
  return true;
}

/** Installs the plugin into DeepSeek Harness. DSH must be restarted afterwards. */
export function connectDeepSeek() {
  const source = pluginSource();
  if (!source) throw new Error('找不到随 App 附带的 DeepSeek 插件');
  if (!exists(DSH_PROFILE)) throw new Error('没有找到 DeepSeek Harness 的配置（~/.dsh/profiles/desktop），请先打开一次 DeepSeek Harness');

  fs.rmSync(PLUGIN_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PLUGIN_HOME), { recursive: true });
  fs.cpSync(source, PLUGIN_HOME, { recursive: true });

  const pkgFile = path.join(DSH_PROFILE, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) throw new Error('DeepSeek Harness 的 package.json 读不出来');
  fs.copyFileSync(pkgFile, pkgFile + '.fire-ring-backup');
  pkg.dependencies = { ...(pkg.dependencies || {}), [PLUGIN_NAME]: 'link:' + PLUGIN_HOME };
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

  const lockFile = path.join(DSH_PROFILE, 'pnpm-lock.yaml');
  if (exists(lockFile)) {
    const next = lockWithPlugin(fs.readFileSync(lockFile, 'utf8'), PLUGIN_HOME);
    if (next) {
      fs.copyFileSync(lockFile, lockFile + '.fire-ring-backup');
      fs.writeFileSync(lockFile, next);
    }
  }

  const linkDir = path.join(DSH_PROFILE, 'node_modules', '@local');
  const link = path.join(linkDir, 'dsh-sessions');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.relative(linkDir, PLUGIN_HOME), link);
  console.log('[setup] DeepSeek Harness plugin connected at ' + PLUGIN_HOME);
  return dshPluginState();
}

/** Takes the plugin out of DeepSeek Harness again. */
export function disconnectDeepSeek() {
  const pkgFile = path.join(DSH_PROFILE, 'package.json');
  const pkg = readJson(pkgFile);
  if (pkg) {
    if (pkg.dependencies) delete pkg.dependencies[PLUGIN_NAME];
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME);
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  }
  const lockFile = path.join(DSH_PROFILE, 'pnpm-lock.yaml');
  if (exists(lockFile)) fs.writeFileSync(lockFile, lockWithoutPlugin(fs.readFileSync(lockFile, 'utf8')));
  fs.rmSync(path.join(DSH_PROFILE, 'node_modules', '@local', 'dsh-sessions'), { force: true });
  fs.rmSync(PLUGIN_HOME, { recursive: true, force: true });
  console.log('[setup] DeepSeek Harness plugin removed');
  return dshPluginState();
}

export const _test = { lockWithPlugin, lockWithoutPlugin };
