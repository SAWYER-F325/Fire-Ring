// "Is the user looking at DSH right now?" without asking for Accessibility.
//
// `lsappinfo front` reports the frontmost process, which needs no permission.
// macOS cannot tell us which conversation the single DSH window shows, so the
// caller combines this with the session metadata (last user prompt) instead.
import { execFileSync } from 'node:child_process';

const DSH_BUNDLES = new Set(['DeepSeek Harness', 'DeepSeekHarness']);

let cache = { at: 0, name: '' };

export function frontmostAppName() {
  const now = Date.now();
  if (now - cache.at < 700) return cache.name;
  let name = '';
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 1500 }).trim();
    if (asn) {
      const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], {
        encoding: 'utf8',
        timeout: 1500,
      });
      const match = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
      name = match ? match[1] : '';
    }
  } catch {
    name = '';
  }
  cache = { at: now, name };
  return name;
}

export function dshIsFrontmost() {
  return DSH_BUNDLES.has(frontmostAppName());
}
