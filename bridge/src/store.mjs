// Which conversation is on screen right now.
//
// The DSH client persists the open conversation as the `dsh.sessions.current`
// key in its Electron local storage (a LevelDB). The active LevelDB log is
// uncompressed and append-only, so the newest record for that key is the
// conversation the window is showing. Reading it needs no permission and no
// automation of the DSH UI; if the file is missing or unreadable we simply fall
// back to "unknown".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVELDB_DIR = process.env.DSH_BRIDGE_STORE_DIR || path.join(
  os.homedir(),
  'Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb',
);

const KEY = Buffer.from('dsh.sessions.current', 'utf8');
const VALUE_START = Buffer.from('{"sessionId":"', 'utf8');

function newestLog() {
  let entries;
  try {
    entries = fs.readdirSync(LEVELDB_DIR).filter((f) => f.endsWith('.log'));
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    const full = path.join(LEVELDB_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { full, mtimeMs: stat.mtimeMs };
    } catch {
      /* ignore */
    }
  }
  return best?.full ?? null;
}

export function currentSessionId() {
  const file = newestLog();
  if (!file) return null;
  let buffer;
  try {
    const size = fs.statSync(file).size;
    const window = Math.min(size, 512 * 1024);
    const handle = fs.openSync(file, 'r');
    buffer = Buffer.alloc(window);
    fs.readSync(handle, buffer, 0, window, size - window);
    fs.closeSync(handle);
  } catch {
    return null;
  }

  const at = buffer.lastIndexOf(KEY);
  if (at < 0) return null;
  const end = Math.min(buffer.length, at + KEY.length + 512);
  const valueAt = buffer.indexOf(VALUE_START, at + KEY.length);
  if (valueAt < 0 || valueAt > end) return null;
  const from = valueAt + VALUE_START.length;
  const close = buffer.indexOf(Buffer.from('"'), from);
  if (close < 0) return null;
  const id = buffer.toString('utf8', from, close);
  // Session ids in the projection cache and in logs are bare UUIDs; the client
  // store prefixes them with "session-". Normalize to the bare form.
  return /^session-[0-9a-f-]{36}$/.test(id) ? id.slice('session-'.length) : null;
}
