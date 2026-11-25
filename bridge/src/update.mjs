// Checking GitHub for a newer Fire Ring, and getting it ready to install.
//
// A release is a GitHub release tagged vX.Y.Z with two files per chip:
//   FireRing-X.Y.Z-arm64.zip          the app, zipped with ditto
//   FireRing-X.Y.Z-arm64.zip.sha256   its SHA-256, as `shasum -a 256` prints it
// (and the same pair for x86_64). The .dmg next to them is for people
// downloading by hand; the updater never uses it.
//
// The bridge downloads and checks the zip, unpacks it and confirms it is Fire
// Ring at the promised version. Swapping the app itself is left to the app,
// which quits, lets a small script move the new copy in, and reopens.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_PATH, UPDATE_REPO, UPDATES_DIR, VERSION, readConfig } from './config.mjs';
import { currentRoute, downloadThroughEgress, getThroughEgress } from './egress.mjs';

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const BUNDLE_ID = 'dev.firering.app';
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// phase: idle | checking | latest | available | downloading | ready | error | unconfigured
let status = {
  phase: REPO.test(UPDATE_REPO) ? 'idle' : 'unconfigured',
  current: VERSION,
  repo: UPDATE_REPO,
  checkedAt: null,
  latest: null,      // { version, notes, url, publishedAt }
  progress: null,    // 0..1 while downloading
  staged: null,      // path of the unpacked app, once ready
  error: null,
};
let inflight = null;
let onChange = () => {};

const set = (patch) => {
  status = { ...status, ...patch };
  onChange(status);
};

/** "1.2.3" or "v1.2.3" → [1, 2, 3]; anything else → null. */
export function parseVersion(text) {
  const m = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** Positive when a is newer than b. A pre-release sorts below its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The pieces of a GitHub "latest release" answer the updater needs. */
export function releaseInfo(body, arch = ARCH) {
  const version = parseVersion(body && body.tag_name) ? String(body.tag_name).replace(/^v/, '') : null;
  if (!version) return null;
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const zipName = `FireRing-${version}-${arch}.zip`;
  const zip = assets.find((a) => a.name === zipName);
  const sum = assets.find((a) => a.name === zipName + '.sha256');
  return {
    version,
    notes: String(body.body || '').slice(0, 4000),
    url: body.html_url || null,
    publishedAt: body.published_at || null,
    zip: zip ? { name: zip.name, url: zip.browser_download_url, size: zip.size } : null,
    sha256Url: sum ? sum.browser_download_url : null,
  };
}

const headers = { 'User-Agent': 'FireRing-Updater', Accept: 'application/vnd.github+json' };

async function check() {
  if (!REPO.test(UPDATE_REPO)) return set({ phase: 'unconfigured' });
  if (currentRoute().offline) return set({ phase: 'offline', error: null });
  set({ phase: 'checking', error: null });
  try {
    const response = await getThroughEgress(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, headers);
    if (response.status === 404) {
      return set({ phase: 'latest', checkedAt: Date.now(), latest: null });   // no release published yet
    }
    if (response.status !== 200) throw new Error('GitHub 返回 HTTP ' + response.status);
    const info = releaseInfo(JSON.parse(response.body));
    if (!info) throw new Error('最新发布的版本号无法识别');
    const newer = compareVersions(info.version, VERSION) > 0;
    const keepStaged = status.staged && status.latest && status.latest.version === info.version;
    set({
      phase: newer ? (keepStaged ? 'ready' : 'available') : 'latest',
      checkedAt: Date.now(),
      latest: info,
      staged: keepStaged ? status.staged : null,
    });
  } catch (error) {
    set({ phase: 'error', checkedAt: Date.now(), error: '检查更新失败：' + error.message });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

async function download() {
  const info = status.latest;
  if (!info || compareVersions(info.version, VERSION) <= 0) throw new Error('没有可安装的新版本');
  if (!info.zip || !info.sha256Url) throw new Error('这个版本没有适合本机芯片（' + ARCH + '）的安装文件');
  const dir = path.join(UPDATES_DIR, info.version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zipFile = path.join(dir, info.zip.name);
  const sumFile = zipFile + '.sha256';
  set({ phase: 'downloading', progress: 0, error: null });

  await downloadThroughEgress(info.sha256Url, sumFile, { headers, maxBytes: 4096 });
  const expected = (fs.readFileSync(sumFile, 'utf8').match(/\b[0-9a-f]{64}\b/i) || [])[0];
  if (!expected) throw new Error('校验文件格式不对');
  let lastShown = 0;
  await downloadThroughEgress(info.zip.url, zipFile, {
    headers,
    onProgress: (got, total) => {
      const p = total ? got / total : 0;
      if (p - lastShown >= 0.02) {
        lastShown = p;
        set({ progress: p });
      }
    },
  });
  if ((await sha256Of(zipFile)).toLowerCase() !== expected.toLowerCase()) throw new Error('下载的文件校验不通过，已丢弃');

  const unpack = path.join(dir, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zipFile, unpack]);
  const app = fs.readdirSync(unpack).find((name) => name.endsWith('.app'));
  if (!app) throw new Error('安装包里没有找到 App');
  const staged = path.join(unpack, app);
  const plist = path.join(staged, 'Contents', 'Info.plist');
  const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).trim();
  const version = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim();
  if (id !== BUNDLE_ID) throw new Error('安装包不是 Fire Ring');
  if (version !== info.version) throw new Error('安装包版本与发布不符');
  fs.rmSync(zipFile, { force: true });
  console.log('[update] ' + info.version + ' downloaded and checked');
  set({ phase: 'ready', progress: 1, staged });
}

/** Where an update would be installed, and whether that is possible. */
function installTarget() {
  if (!APP_PATH) return { ok: false, reason: '只有从 App 里运行时才能自动更新' };
  if (APP_PATH.startsWith('/Volumes/')) return { ok: false, reason: '请先把 Fire Ring 拖进「应用程序」文件夹再更新' };
  if (APP_PATH.includes('/AppTranslocation/')) return { ok: false, reason: '请先把 Fire Ring 移到「应用程序」文件夹，再重新打开' };
  try {
    fs.accessSync(path.dirname(APP_PATH), fs.constants.W_OK);
  } catch {
    return { ok: false, reason: '没有权限写入 ' + path.dirname(APP_PATH) };
  }
  return { ok: true, path: APP_PATH };
}

export function updateStatus() {
  return { ...status, arch: ARCH, install: installTarget(), autoCheck: readConfig().updates.autoCheck };
}

export function checkForUpdate() {
  if (!inflight) inflight = check().finally(() => { inflight = null; });
  return inflight;
}

export function downloadUpdate() {
  if (inflight) return inflight;
  inflight = download()
    .catch((error) => {
      console.log('[update] failed: ' + error.message);
      set({ phase: 'error', progress: null, error: '更新失败：' + error.message });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Starts the periodic check; `changed` hears every status change. */
export function startUpdateChecks(changed) {
  onChange = changed;
  const tick = () => {
    if (readConfig().updates.autoCheck && !currentRoute().offline) checkForUpdate();
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
