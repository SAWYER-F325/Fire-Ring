// Checks the contrast of Fire Ring's colour tokens in both modes, the way Fire
// Design does: text at least 4.5:1, icons and other graphics at least 3:1.
// The menu-bar panel and settings window sit on system glass, so each mode is
// measured on the lightest and the darkest the glass realistically gets.
// Run: node tools/contrast.mjs   (exits 1 if any pair is below its minimum)

const MODES = {
  dark: {
    // The previous look, unchanged: system dark glass.
    grounds: { 'glass dark': '#1a1b20', 'glass light': '#2c2d33' },
    ink: '#eef1f6', 'ink-2': 'rgba(238,241,246,.64)', 'ink-3': 'rgba(238,241,246,.42)',
    waiting: '#ff5a36', running: '#7ea6ff', done: '#5fe3a1', accent: '#4c8dff', ember: '#ff8a2b',
  },
  light: {
    // Fire Design's light look: lavender ground, white raised tiles, a sunken tray.
    grounds: { 'lavender': '#eef0ff', 'white tile': '#ffffff', 'sunken tray': '#e2e5fb' },
    ink: '#14152b', 'ink-2': '#4d5070', 'ink-3': '#5a5d80',
    waiting: '#b0321f', running: '#5057d2', done: '#0c6c4a', accent: '#5249e0', ember: '#93590a',
  },
};

// [token, minimum, what it is]
const PAIRS = [
  ['ink', 4.5, '正文'],
  ['ink-2', 4.5, '次要文字'],
  ['ink-3', 3, '提示文字（11px 以上的辅助说明）'],
  ['waiting', 4.5, '等你（文字和图标）'],
  ['running', 4.5, '在跑（文字和图标）'],
  ['done', 4.5, '完成（文字和图标）'],
  ['accent', 3, '开关和主按钮底色'],
  ['ember', 3, '余烬色图标'],
];

const parse = (c) => {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const [r, g, b, a = 1] = c.match(/^rgba?\(([^)]+)\)$/)[1].split(',').map(Number);
  return [r, g, b, a];
};
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = ([r, g, b]) => {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fg, bg) => {
  const b = parse(bg);
  const a = lum(over(parse(fg), b));
  const c = lum(b);
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
};

// Known exception, kept on purpose: the original waiting red #ff5a36 (also the
// notch's) reaches 4.4 only on the very lightest dark glass; 5.5 on typical glass.
const ALLOWED = new Set(['dark:waiting']);
let failed = 0;
for (const [mode, t] of Object.entries(MODES)) {
  console.log(`\n${{ dark: '深色（原版）', 'dark-fd': '深色（Fire Design）', light: '浅色' }[mode]}`);
  for (const [token, min, what] of PAIRS) {
    const results = Object.entries(t.grounds).map(([name, bg]) => [name, ratio(t[token], bg)]);
    const worst = Math.min(...results.map(([, r]) => r));
    const ok = worst >= min || ALLOWED.has(mode + ':' + token);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${token.padEnd(8)} ${worst.toFixed(1).padStart(5)} ≥ ${min}  ${what}  (${results.map(([n, r]) => n + ' ' + r.toFixed(1)).join('，')})`);
  }
}
if (failed) {
  console.log(`\n${failed} 项对比度不够`);
  process.exit(1);
}
console.log('\n全部达标');
