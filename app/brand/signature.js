/*
 * Fire Design 签名字：“A 粗体正装”
 *
 * 字形用尖头笔模型生成：往下压的笔画粗，往上走的连笔细。
 * 书写动画把每一笔切成小块，笔尖走到哪一块，哪一块才出现，
 * 刚出现时亮一下再回到金色。不用遮罩扫描，所以不会把旁边的笔画提前带出来。
 *
 * 用法（浏览器）：
 *   <svg id="sig"></svg>
 *   <script src="brand/signature/signature.js"></script>
 *   <script>FireSignature.mount(document.getElementById('sig'), 'fire')</script>
 *
 * mount(svg, word, options) 的 options：
 *   color     填充色，默认余烬金 #f7c46a；浅底建议 #b87410
 *   flash     笔尖刚走到时的亮色，默认 #fff3d6；浅底建议和 color 相同
 *   loop      true 时写完停一会儿再重写，默认 false
 *   hold      循环时写完后停留的秒数，默认 6
 *   animate   false 时直接显示写好的字，默认 true；系统开启“减弱动态效果”时也直接显示
 * 返回 { replay(), destroy(), duration }。
 *
 * 在 Node 里 require 这个文件可以拿到 path(word)，用来导出静态 SVG。
 */
(function (root) {
  'use strict';

  // 倾斜系数：0.3，偏直立
  const SLANT = 0.3;

  // 字形骨架。坐标先按直立书写，再统一加倾斜。
  // W 是往下压时的最大笔宽，H 是往上走时的发丝宽度；start、dur 单位是秒。
  const WORDS = {
    sawyer: {
      label: 'Sawyer',
      viewBox: '30 10 640 300',
      strokes: [
        { // 大写 S
          c: 'M96 138C120 108 150 78 176 56C186 48 184 36 170 36C140 34 118 62 124 92C130 122 160 136 156 170C152 200 110 214 78 204C58 198 52 176 70 170C80 168 86 178 80 186',
          W: 17.92, H: 3.2, start: 0, dur: 1.1,
        },
        { // awyer 一笔连写
          c: 'M222 146C205 130 170 138 164 168C160 190 172 206 190 202C206 198 218 170 224 142C218 170 214 192 226 200C236 206 254 190 268 146C262 175 262 200 280 202C296 204 308 175 314 146C308 175 308 200 326 202C346 204 362 170 360 148C358 140 348 142 350 152C352 160 370 158 392 146C388 175 386 200 404 202C420 204 432 175 438 146C432 190 424 240 408 272C398 290 376 290 382 268C388 246 430 214 470 190C490 178 506 160 504 148C502 136 484 138 476 158C468 182 478 206 500 202C520 198 536 170 546 146C552 138 566 144 578 140C574 168 572 196 590 200C602 202 616 194 626 184',
          W: 16, H: 3.2, start: 1.3, dur: 3.2,
        },
      ],
    },
    fire: {
      label: 'fire',
      viewBox: '45 15 430 290',
      strokes: [
        { // f 的竖笔：顶部回勾，长竖穿过基线，底部向左收
          c: 'M214 56C208 36 186 28 174 42C164 54 160 80 158 110C155 150 152 230 140 272C134 292 116 298 106 284',
          W: 16, H: 3.2, step: 2.5, start: 0, dur: 0.9,
        },
        { // 横笔穿过竖笔，连写 i、r（顶上打小圈）、e
          c: 'M118 150C145 140 180 136 212 138C206 160 204 188 212 200C216 206 232 204 244 190C250 176 257 150 264 128C269 112 258 104 252 114C247 123 256 136 270 134C280 132 288 134 288 146C287 166 284 188 286 198C288 206 312 206 328 194C344 180 358 164 362 150C366 138 354 132 346 140C336 150 334 176 338 190C342 204 364 206 380 196C390 190 400 182 408 176',
          W: 13.5, H: 3, step: 2.5, start: 1.05, dur: 2.3,
        },
        { // i 的点，最后写
          c: 'M208 116C211 112 214 109 218 106',
          W: 10, H: 10, head: 0.2, tail: 0.35, step: 2, start: 3.55, dur: 0.22,
        },
      ],
    },
  };

  const slant = d => d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (m, x, y) => (+x + (200 - +y) * SLANT).toFixed(1) + ' ' + y);

  // 把一笔切成小块。每块是一个小四边形，首尾各加一个圆头。
  function ribbon(st, k) {
    const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const geo = d => {
      const n = d.match(/-?[\d.]+/g).map(Number), raw = [];
      let x0 = n[0], y0 = n[1], len = 0;
      raw.push({ x: x0, y: y0, s: 0 });
      for (let i = 2; i < n.length; i += 6) {
        const x1 = n[i], y1 = n[i + 1], x2 = n[i + 2], y2 = n[i + 3], x3 = n[i + 4], y3 = n[i + 5];
        let px = x0, py = y0;
        for (let j = 1; j <= 48; j++) {
          const t = j / 48, u = 1 - t;
          const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          len += Math.hypot(x - px, y - py); raw.push({ x, y, s: len }); px = x; py = y;
        }
        x0 = x3; y0 = y3;
      }
      return { raw, len };
    };
    const at = (g, s) => {
      const r = g.raw; let lo = 0, hi = r.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m].s < s) lo = m; else hi = m; }
      const a = r[lo], b = r[hi], t = b.s === a.s ? 0 : (s - a.s) / (b.s - a.s);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, th: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    // 笔尖速度按 cubic-bezier(.42,.02,.4,1)：起笔慢、中段快、收笔慢。timeAt(u) 求走到 u 处的时间比例。
    const bz = (p1, p2, s) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
    const timeAt = u => { let lo = 0, hi = 1; for (let j = 0; j < 30; j++) { const m = (lo + hi) / 2; if (bz(.02, 1, m) < u) lo = m; else hi = m; } return bz(.42, .4, (lo + hi) / 2); };
    const f = v => +v.toFixed(1);
    const poly = pts => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], r = pts[(i + 1) % pts.length]; a += p[0] * r[1] - r[0] * p[1]; }
      if (a < 0) pts = pts.slice().reverse(); // 所有小块同向，合成一条路径时不会互相抵消
      return 'M' + pts.map(p => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
    };

    const W = st.W, H = st.H, step = st.step || 5, g = geo(slant(st.c));
    const n = Math.max(4, Math.round(g.len / step)), q = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = at(g, t * g.len);
      const down = Math.max(0, Math.sin(p.th)); // 往下走的分量越大，笔越粗
      let w = H + (W - H) * Math.pow(down, 1.5);
      w *= (.5 + .5 * sm(0, st.head ?? .05, t)) * (.25 + .75 * (1 - sm(1 - (st.tail ?? .08), 1, t)));
      q.push({ p, w, t });
    }
    for (let j = 0; j < 7; j++) { const c = q.map(v => v.w); for (let i = 1; i < n; i++) q[i].w = (c[i - 1] + 2 * c[i] + c[i + 1]) / 4; }
    const L = q.map(({ p, w }) => [p.x - Math.sin(p.th) * w / 2, p.y + Math.cos(p.th) * w / 2]);
    const R = q.map(({ p, w }) => [p.x + Math.sin(p.th) * w / 2, p.y - Math.cos(p.th) * w / 2]);
    const cap = (v, a0) => { const c = [], h = v.w / 2; for (let j = 1; j < 4; j++) { const a = v.p.th + a0 - j * Math.PI / 4; c.push([v.p.x + Math.cos(a) * h, v.p.y + Math.sin(a) * h]); } return c; };
    const when = u => +(st.start + st.dur * timeAt(u)).toFixed(3);

    const out = [{ d: poly([R[0], ...cap(q[0], -Math.PI / 2), L[0]]), t: when(0), u: 0, k }];
    for (let i = 0; i < n; i++) out.push({ d: poly([L[i], L[i + 1], R[i + 1], R[i]]), t: when(q[i].t), u: q[i].t, k });
    out.push({ d: poly([L[n], ...cap(q[n], Math.PI / 2), R[n]]), t: when(1), u: 1, k });
    return out;
  }

  const cache = {};
  function pieces(word) {
    const w = WORDS[word];
    if (!w) throw new Error('FireSignature: 没有这个词 ' + word + '，可用：' + Object.keys(WORDS).join('、'));
    return cache[word] || (cache[word] = w.strokes.flatMap((st, k) => ribbon(st, k)));
  }

  // 整个词合成一条路径，用于静态显示和导出
  const path = word => pieces(word).map(p => p.d).join('');
  const duration = word => Math.max(...WORDS[word].strokes.map(s => s.start + s.dur)) + 0.2;

  const PIECE_SECONDS = 0.18;
  let styled = false;
  function injectStyle(doc) {
    if (styled) return; styled = true;
    const s = doc.createElement('style');
    s.textContent =
      '@keyframes fd-sig-hot{0%{visibility:visible;fill:var(--fd-sig-flash);stroke:var(--fd-sig-flash)}100%{visibility:visible;fill:var(--fd-sig-color);stroke:var(--fd-sig-color)}}' +
      '.fd-sig-pc{visibility:hidden;fill:var(--fd-sig-color);stroke:var(--fd-sig-color);stroke-width:.7;stroke-linejoin:round;animation:fd-sig-hot ' + PIECE_SECONDS + 's ease-out forwards}';
    doc.head.appendChild(s);
  }

  function mount(svg, word, opts) {
    const o = Object.assign({ color: '#f7c46a', flash: '#fff3d6', loop: false, hold: 6, animate: true }, opts || {});
    const doc = svg.ownerDocument, NS = 'http://www.w3.org/2000/svg';
    const w = WORDS[word], ps = pieces(word), total = duration(word);
    const reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.setAttribute('viewBox', w.viewBox);
    svg.setAttribute('role', 'img');
    if (!svg.hasAttribute('aria-label')) svg.setAttribute('aria-label', '签名 ' + w.label);
    svg.style.setProperty('--fd-sig-color', o.color);
    svg.style.setProperty('--fd-sig-flash', o.flash);
    let timer = null;

    function drawStatic() {
      svg.textContent = '';
      const p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', path(word));
      p.setAttribute('fill', o.color); p.setAttribute('stroke', o.color);
      p.setAttribute('stroke-width', '.7'); p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    function drawAnimated() {
      injectStyle(doc);
      svg.textContent = '';
      const frag = doc.createDocumentFragment();
      for (const pc of ps) {
        const p = doc.createElementNS(NS, 'path');
        p.setAttribute('class', 'fd-sig-pc');
        p.setAttribute('d', pc.d);
        p.style.animationDelay = pc.t + 's';
        frag.appendChild(p);
      }
      svg.appendChild(frag);
      // 写完后换成一条合成路径，减少节点
      clearTimeout(timer);
      timer = setTimeout(() => {
        drawStatic();
        if (o.loop) timer = setTimeout(drawAnimated, o.hold * 1000);
      }, (total + PIECE_SECONDS) * 1000);
    }
    function replay() { clearTimeout(timer); (o.animate && !reduce) ? drawAnimated() : drawStatic(); }
    replay();
    return { replay, destroy() { clearTimeout(timer); svg.textContent = ''; }, duration: total };
  }

  const api = { WORDS, mount, path, pieces, duration, SLANT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FireSignature = api;
})(typeof window !== 'undefined' ? window : globalThis);
