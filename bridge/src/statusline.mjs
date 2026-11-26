// Claude Code status line for Fire Ring.
//
// Claude Code runs this after its replies and pipes a JSON description of the
// session to stdin; for subscribers it includes `rate_limits` (the 5-hour and
// weekly windows, as used percentages and reset times). This keeps only those
// numbers, in Fire Ring's data folder, and prints a short line for terminals.
//
// No network, no sign-in: the numbers come from Claude Code itself.
// Set up in ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "<node> <this file>" }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = process.env.FIRE_RING_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Fire Ring');
export const STATUSLINE_FILE = path.join(DATA_DIR, 'claude-statusline.json');

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function resetText(seconds) {
  const at = new Date(seconds * 1000);
  const now = new Date();
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const day = days === 0 ? '' : days === 1 ? '明天 ' : WEEKDAYS[at.getDay()] + ' ';
  return day + pad(at.getHours()) + ':' + pad(at.getMinutes());
}

function windowText(label, w) {
  if (!w || !Number.isFinite(w.used_percentage)) return null;
  const left = Math.max(0, Math.round(100 - w.used_percentage));
  return label + ' 剩 ' + left + '%' + (Number.isFinite(w.resets_at) ? '（' + resetText(w.resets_at) + ' 重置）' : '');
}

const clean = (w) => (w && Number.isFinite(w.used_percentage)
  ? { used_percentage: w.used_percentage, resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null }
  : null);

/** Keeps just the limit numbers, written whole so a reader never sees half a file. */
export function save(limits, now = Date.now()) {
  const reading = { five_hour: clean(limits.five_hour), seven_day: clean(limits.seven_day) };
  if (!reading.five_hour && !reading.seven_day) return false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = STATUSLINE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ observedAt: now, rate_limits: reading }));
  fs.renameSync(temp, STATUSLINE_FILE);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const quiet = process.argv.includes('--quiet');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let session = {};
  try {
    session = JSON.parse(input);
  } catch {
    /* nothing usable; still print a line */
  }
  const limits = session.rate_limits || {};
  try {
    save(limits);
  } catch {
    /* the status line must still render */
  }
  if (!quiet) {
    const parts = [windowText('5 小时', limits.five_hour), windowText('本周', limits.seven_day)].filter(Boolean);
    process.stdout.write(parts.length ? 'Fire Ring · ' + parts.join(' · ') : 'Fire Ring');
  }
}
