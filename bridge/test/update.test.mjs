import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.FIRE_RING_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-ring-update-'));
const { compareVersions, parseVersion, releaseInfo } = await import('../src/update.mjs');
const { validProxyUrl } = await import('../src/config.mjs');
const { _test } = await import('../src/integrations.mjs');

test('versions compare by number, not by text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('0.1.0', '0.2.0') < 0);
  assert.equal(parseVersion('release-1'), null);
});

test('a release gives the zip and checksum for this chip only', () => {
  const body = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/o/r/releases/tag/v0.2.0',
    body: '修复了一些问题',
    assets: [
      { name: 'FireRing-0.2.0-arm64.zip', browser_download_url: 'https://x/arm.zip', size: 10 },
      { name: 'FireRing-0.2.0-arm64.zip.sha256', browser_download_url: 'https://x/arm.zip.sha256' },
      { name: 'FireRing-0.2.0-x86_64.zip', browser_download_url: 'https://x/intel.zip', size: 10 },
      { name: 'FireRing-0.2.0.dmg', browser_download_url: 'https://x/a.dmg' },
    ],
  };
  const arm = releaseInfo(body, 'arm64');
  assert.equal(arm.version, '0.2.0');
  assert.equal(arm.zip.url, 'https://x/arm.zip');
  assert.equal(arm.sha256Url, 'https://x/arm.zip.sha256');
  const intel = releaseInfo(body, 'x86_64');
  assert.equal(intel.zip.url, 'https://x/intel.zip');
  assert.equal(intel.sha256Url, null);   // no checksum published: cannot be installed
  assert.equal(releaseInfo({ tag_name: 'nightly' }), null);
});

test('only plain http://host:port proxies are accepted', () => {
  assert.ok(validProxyUrl('http://127.0.0.1:8080'));
  assert.ok(validProxyUrl('http://proxy.local:8080/'));
  assert.ok(!validProxyUrl('https://127.0.0.1:7890'));
  assert.ok(!validProxyUrl('socks5://127.0.0.1:7890'));
  assert.ok(!validProxyUrl('http://user:pass@127.0.0.1:7890'));
  assert.ok(!validProxyUrl('http://127.0.0.1:99999'));
  assert.ok(!validProxyUrl(''));
});

test('the DeepSeek lockfile entry is added, replaced and removed cleanly', () => {
  const home = os.homedir();
  const target = path.join(home, '.dsh', 'plugins', 'fire-ring');
  const empty = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
  const added = _test.lockWithPlugin(empty, target);
  assert.match(added, /'@local\/dsh-sessions':\n {8}specifier: link:.*fire-ring\n {8}version: link:\.\.\/\.\.\/plugins\/fire-ring\n/);
  const old = added.replace(/specifier: link:[^\n]*/, 'specifier: link:/old/place').replace(/version: link:[^\n]*/, 'version: link:../old');
  const replaced = _test.lockWithPlugin(old, target);
  assert.equal(replaced, added);
  assert.equal(_test.lockWithoutPlugin(added), empty);
  assert.equal(_test.lockWithPlugin('something else entirely', target), null);
});
