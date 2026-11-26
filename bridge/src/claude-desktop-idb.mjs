// Read-only local parser for Claude Desktop's IndexedDB rate-limit verdicts
// (`current_account` React Query cache -> `messageLimits`).
//
// Zero external dependencies, zero network requests, zero credential access.
// Only reads numeric quota windows (`5h`, `7d`, model-scoped windows), reset
// timestamps, and observation timestamps; never inspects or returns account,
// token, or conversation data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { windowOf } from './window.mjs';

const IDB_DIR = () => process.env.FIRE_RING_CLAUDE_IDB_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');

const MAX_SNAPPY_OUT = 16 * 1024 * 1024;
const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const FIVE_HOUR_MAX_AGE_MS = 6 * 60 * 60_000;
const WAL_BLOCK_SIZE = 32768;
const IDB_SNAPPY_MAGIC = Buffer.from([0xff, 0x11, 0x02]);
const V8_HEADER_V15 = Buffer.from([0xff, 0x0f]);
const V8_HEADER_V16 = Buffer.from([0xff, 0x10]);

/** Pure-JS Snappy block decompressor (returns null on invalid/truncated data). */
export function snappyDecompress(src) {
  if (!src || !src.length) return null;
  let pos = 0;
  let len = 0;
  let shift = 0;
  while (pos < src.length && shift < 35) {
    const b = src[pos++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (len <= 0 || len > MAX_SNAPPY_OUT) return null;
  const out = Buffer.allocUnsafe(len);
  let op = 0;
  while (pos < src.length && op < len) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {
      let l = (tag >> 2) + 1;
      if (l > 60) {
        const extra = l - 60;
        if (pos + extra > src.length) return null;
        l = 0;
        for (let i = 0; i < extra; i++) l |= src[pos++] << (8 * i);
        l += 1;
      }
      if (pos + l > src.length || op + l > len) return null;
      src.copy(out, op, pos, pos + l);
      pos += l;
      op += l;
    } else {
      let l;
      let off;
      if (type === 1) {
        if (pos >= src.length) return null;
        l = ((tag >> 2) & 7) + 4;
        off = ((tag & 0xe0) << 3) | src[pos++];
      } else if (type === 2) {
        if (pos + 2 > src.length) return null;
        l = (tag >> 2) + 1;
        off = src[pos] | (src[pos + 1] << 8);
        pos += 2;
      } else {
        if (pos + 4 > src.length) return null;
        l = (tag >> 2) + 1;
        off = src.readUInt32LE(pos);
        pos += 4;
      }
      if (off === 0 || off > op || op + l > len) return null;
      for (let i = 0; i < l; i++) out[op + i] = out[op - off + i];
      op += l;
    }
  }
  return op === len ? out : null;
}

/** Reassembles LevelDB WAL (.log) 32 KiB block-framed records. */
export function readWalRecords(buf) {
  let off = 0;
  let cur = [];
  const records = [];
  while (off < buf.length) {
    const rem = WAL_BLOCK_SIZE - (off % WAL_BLOCK_SIZE);
    if (rem < 7) { off += rem; continue; }
    if (off + 7 > buf.length) break;
    const len = buf.readUInt16LE(off + 4);
    const type = buf[off + 6];
    if (type === 0 || off + 7 + len > buf.length) { off += rem; continue; }
    const chunk = buf.subarray(off + 7, off + 7 + len);
    off += 7 + len;
    if (type === 1) { records.push(chunk); cur = []; }
    else if (type === 2) { cur = [chunk]; }
    else if (type === 3) { cur.push(chunk); }
    else if (type === 4) { cur.push(chunk); records.push(Buffer.concat(cur)); cur = []; }
  }
  return records;
}

function readVarint(buf, pos) {
  let v = 0;
  let shift = 0;
  while (pos < buf.length && shift < 49) {
    const b = buf[pos++];
    v += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [v, pos];
}

function readSstableBlock(buf, offset, size) {
  if (offset < 0 || size <= 0 || offset + size + 1 > buf.length) return null;
  const raw = buf.subarray(offset, offset + size);
  const comp = buf[offset + size];
  if (comp === 0) return raw;
  if (comp === 1) return snappyDecompress(raw);
  return null;
}

function readSstableHandles(buf) {
  if (buf.length < 48) return [];
  const footer = buf.subarray(buf.length - 48);
  let pos = 0;
  [, pos] = readVarint(footer, pos); // meta offset
  [, pos] = readVarint(footer, pos); // meta size
  const [idxOff, p3] = readVarint(footer, pos);
  const [idxSize] = readVarint(footer, p3);
  const idxBlock = readSstableBlock(buf, idxOff, idxSize);
  if (!idxBlock || idxBlock.length < 8) return [];
  const numRestarts = idxBlock.readUInt32LE(idxBlock.length - 4);
  const limit = idxBlock.length - 4 - numRestarts * 4;
  if (limit <= 0) return [];
  const handles = [];
  let ip = 0;
  while (ip < limit) {
    let nonShared;
    let valLen;
    [, ip] = readVarint(idxBlock, ip);
    [nonShared, ip] = readVarint(idxBlock, ip);
    [valLen, ip] = readVarint(idxBlock, ip);
    const valStart = ip + nonShared;
    if (valStart + valLen > limit) break;
    const [bOff, d1] = readVarint(idxBlock, valStart);
    const [bSize] = readVarint(idxBlock, d1);
    handles.push([bOff, bSize]);
    ip = valStart + valLen;
  }
  return handles;
}

const SCOPED_LABELS = {
  '7d_opus': '本周 Opus',
  seven_day_opus: '本周 Opus',
  '7d_sonnet': '本周 Sonnet',
  seven_day_sonnet: '本周 Sonnet',
  '7d_fable': '本周 Fable',
  seven_day_fable: '本周 Fable',
};

function toPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n <= 1 ? n * 100 : n;
}

function toSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function normalizeMessageLimits(map, fallbackAt) {
  if (!map || typeof map !== 'object') return null;
  let best = null;
  for (const entry of Object.values(map)) {
    if (!entry || typeof entry !== 'object') continue;
    const receivedAt = Number(entry.receivedAt) || fallbackAt || 0;
    const rawWindows = entry.windows && typeof entry.windows === 'object' ? entry.windows : null;
    if (!rawWindows) continue;
    const parsedWindows = [];
    const parsedExtras = [];
    for (const [key, w] of Object.entries(rawWindows)) {
      if (!w || typeof w !== 'object') continue;
      const pct = toPercent(w.utilization);
      if (pct === null) continue;
      const resetsAt = toSeconds(w.resets_at ?? w.resetsAt ?? entry.resetsAt);
      if (key === '5h' || key === 'five_hour') {
        parsedWindows.push({ kind: 'five_hour', usedPercent: pct, resetsAt });
      } else if (key === '7d' || key === 'seven_day') {
        parsedWindows.push({ kind: 'weekly', usedPercent: pct, resetsAt });
      } else if (SCOPED_LABELS[key]) {
        parsedExtras.push({ label: SCOPED_LABELS[key], usedPercent: pct, resetsAt });
      }
    }
    if (!parsedWindows.length) continue;
    if (!best || receivedAt > best.observedAt) {
      best = { observedAt: receivedAt, windows: parsedWindows, extras: parsedExtras };
    }
  }
  return best;
}

function deserializeV8Object(dec) {
  const idx = dec.indexOf(V8_HEADER_V16) >= 0 ? dec.indexOf(V8_HEADER_V16) : dec.indexOf(V8_HEADER_V15);
  if (idx < 0) return null;
  const slice = dec.subarray(idx);
  try {
    return v8.deserialize(slice);
  } catch {
    if (slice[1] === 0x10) {
      try {
        const copy = Buffer.from(slice);
        copy[1] = 0x0f;
        return v8.deserialize(copy);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readV8NumberAfter(buf, key, start = 0, end = buf.length) {
  const idx = buf.indexOf(key, start);
  if (idx < 0 || idx >= end) return null;
  const pos = idx + key.length;
  if (pos >= end) return null;
  if (buf[pos] === 0x4e && pos + 9 <= end) return buf.readDoubleLE(pos + 1);
  if (buf[pos] === 0x49 && pos + 2 <= end) {
    // ZigZag-encoded SMI varint
    const [z] = readVarint(buf, pos + 1);
    return (z >>> 1) ^ -(z & 1);
  }
  return null;
}

/** Fallback binary extractor if a future V8 wire version cannot be deserialized directly. */
function fallbackExtractMessageLimits(dec, fallbackAt) {
  const mIdx = dec.indexOf('messageLimits');
  if (mIdx < 0) return null;
  const end = Math.min(dec.length, mIdx + 2048);
  const util = readV8NumberAfter(dec, 'utilization', mIdx, end);
  if (util === null) return null;
  const pct = toPercent(util);
  if (pct === null) return null;
  const resets = toSeconds(
    readV8NumberAfter(dec, 'resets_at', mIdx, end) ?? readV8NumberAfter(dec, 'resetsAt', mIdx, end),
  );
  const receivedAt = Number(readV8NumberAfter(dec, 'receivedAt', mIdx, end)) || fallbackAt || 0;
  const region = dec.subarray(mIdx, end);
  const isFiveHour = region.includes('five_hour') && !region.includes('seven_day');
  return {
    observedAt: receivedAt,
    windows: [{ kind: isFiveHour ? 'five_hour' : 'weekly', usedPercent: pct, resetsAt: resets }],
    extras: [],
  };
}

function extractFromDecompressed(dec, fallbackAt) {
  if (!dec || !dec.includes('messageLimits')) return null;
  const obj = deserializeV8Object(dec);
  if (obj && typeof obj === 'object') {
    const ts = Number(obj.timestamp) || fallbackAt;
    if (obj.messageLimits) {
      const direct = normalizeMessageLimits(obj.messageLimits, ts);
      if (direct) return direct;
    }
    const queries = obj.clientState && Array.isArray(obj.clientState.queries) ? obj.clientState.queries : [];
    for (const q of queries) {
      const limits = q && q.state && q.state.data && q.state.data.messageLimits;
      if (!limits) continue;
      const parsed = normalizeMessageLimits(limits, Number(q.state.dataUpdatedAt) || ts);
      if (parsed) return parsed;
    }
  }
  return fallbackExtractMessageLimits(dec, fallbackAt);
}

function extractFromChunk(chunk, fallbackAt) {
  let best = null;
  // First check uncompressed payloads (small values in LevelDB)
  if (chunk.includes('messageLimits')) {
    const direct = extractFromDecompressed(chunk, fallbackAt);
    if (direct && (!best || direct.observedAt > best.observedAt)) best = direct;
  }
  // Then check Chromium IndexedDB Snappy-compressed values (0xff 0x11 0x02)
  let p = 0;
  while ((p = chunk.indexOf(IDB_SNAPPY_MAGIC, p)) !== -1) {
    const dec = snappyDecompress(chunk.subarray(p + 3));
    if (dec) {
      const parsed = extractFromDecompressed(dec, fallbackAt);
      if (parsed && (!best || parsed.observedAt > best.observedAt)) best = parsed;
    }
    p += 3;
  }
  return best;
}

let idbCache = { key: '', value: null };

function loadLatestIdbLimits() {
  const dir = IDB_DIR();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    idbCache = { key: '', value: null };
    return null;
  }
  const logs = [];
  const tables = [];
  for (const name of names) {
    if (!name.endsWith('.log') && !name.endsWith('.ldb')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      const item = { name, full, mtime: st.mtimeMs, size: st.size };
      if (name.endsWith('.log')) logs.push(item);
      else tables.push(item);
    } catch { /* compacted away */ }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  tables.sort((a, b) => b.mtime - a.mtime);
  const candidates = [...logs.slice(0, 2), ...tables.slice(0, 4)];
  if (!candidates.length) {
    idbCache = { key: '', value: null };
    return null;
  }
  const key = candidates.map((c) => `${c.name}:${c.mtime}:${c.size}`).join('|');
  if (key === idbCache.key) return idbCache.value;

  let best = null;
  // 1. Newest WAL (.log) records from end -> newest write wins immediately.
  for (const log of logs.slice(0, 2)) {
    let buf;
    try { buf = fs.readFileSync(log.full); } catch { continue; }
    const recs = readWalRecords(buf);
    for (let i = recs.length - 1; i >= 0; i--) {
      const parsed = extractFromChunk(recs[i], log.mtime);
      if (parsed && (!best || parsed.observedAt > best.observedAt)) {
        best = parsed;
        break;
      }
    }
    if (best) break;
  }

  // 2. If WAL was just rotated, scan newest SSTable (.ldb) blocks backwards.
  if (!best) {
    for (const tbl of tables.slice(0, 4)) {
      let buf;
      try { buf = fs.readFileSync(tbl.full); } catch { continue; }
      const handles = readSstableHandles(buf);
      for (let i = handles.length - 1; i >= 0; i--) {
        const block = readSstableBlock(buf, handles[i][0], handles[i][1]);
        if (!block) continue;
        if (!block.includes('messageLimits') && !block.includes('approaching_limit') && !block.includes('utilization')) continue;
        const parsed = extractFromChunk(block, tbl.mtime);
        if (parsed && (!best || parsed.observedAt > best.observedAt)) best = parsed;
      }
      if (best) break;
    }
  }

  idbCache = { key, value: best };
  return best;
}

/** Reads Claude Desktop's live local IndexedDB rate-limit windows (`5h` / `7d` + exact `resetsAt`). */
export function readClaudeDesktopIdbQuota(now = Date.now()) {
  const raw = loadLatestIdbLimits();
  if (!raw || !raw.observedAt || now - raw.observedAt > MAX_AGE_MS) return null;
  const windows = [];
  for (const w of raw.windows) {
    if (w.kind === 'five_hour' && now - raw.observedAt > FIVE_HOUR_MAX_AGE_MS) continue;
    windows.push(windowOf(w.kind, w.usedPercent, w.resetsAt, now));
  }
  if (!windows.length) return null;
  const extras = (raw.extras || []).map((e) => ({
    label: e.label,
    ...windowOf('scoped', e.usedPercent, e.resetsAt, now),
  }));
  return {
    state: 'ok',
    source: 'desktop',
    observedAt: raw.observedAt,
    windows,
    extras,
  };
}
