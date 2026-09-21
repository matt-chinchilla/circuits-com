/* <fire-edge> — the Burning Badge particle fire, generalised to a moving burn front.
   Ported from fire-badge.js (same sprites, LUT, flicker/wind model, shared rAF loop).
   Fills its positioned parent (position:absolute; inset:0) and paints on a padded canvas.
   Attributes:
     active   "true" starts a burn, "false" clears it (re-flip to replay)
     mode     lip   — fire rides the host's bottom edge across its full width (panel reveal)
              line  — a burn head travels x1,y1 → x2,y2 (% of host box), fire + smoke trail it
              sweep — a vertical front sweeps left → right across the host (text ignite)
     delay / duration  seconds · scale  flame size px (≈ text height) · intensity 0.3–2
     opacity 0–1 · blend add|over (add = 'lighter' for dark grounds; over = light grounds)
     scheme  orange|red · pad  canvas overscan px (default 40) · x1 y1 x2 y2  line endpoints (%)
   Off under prefers-reduced-motion and ≤768px viewports (matches the Join page's CSS gates). */
(() => {
  if (customElements.get('fire-edge')) return;
  const SCHEMES = {
    orange: { stops: ['#fff3d8', '#ffb347', '#ff6a12', '#a63a08', '#301004'], spark: '#ffd28a', glow: '#ff7a20' },
    red:    { stops: ['#ffe3e0', '#ff7a6a', '#ee2a1a', '#8e1008', '#2a0404'], spark: '#ffb3a8', glow: '#ff3a2a' },
  };
  const SMOKE = ['#9a8a82', '#6b5a52', '#3e332e'];
  // Glowing-coal ramp (from coals-engine.js): black → deep red → orange → yellow-white
  const STOPS = [[0, [4, 0, 0]], [0.2, [58, 3, 0]], [0.42, [165, 18, 0]], [0.64, [250, 72, 6]], [0.84, [255, 156, 36]], [1, [255, 238, 180]]];
  const RAMP = [];
  for (let i = 0; i < 256; i++) {
    const tt = i / 255; let k = 0;
    while (k < STOPS.length - 2 && tt > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1], f = (tt - t0) / (t1 - t0);
    RAMP.push([Math.round(c0[0] + (c1[0] - c0[0]) * f), Math.round(c0[1] + (c1[1] - c0[1]) * f), Math.round(c0[2] + (c1[2] - c0[2]) * f)]);
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  // Quantised + memoised colour strings: coals otherwise mint a new rgba() string (and a new glow sprite canvas!) per coal per frame.
  const CSSC = new Map();
  const rampCss = (h, a) => { const hq = clamp(Math.round(h * 32), 0, 32), aq = clamp(Math.round(a * 32), 0, 32), k = hq * 64 + aq; let s = CSSC.get(k); if (!s) { const c = RAMP[(hq * 255 / 32) | 0]; s = `rgba(${c[0]},${c[1]},${c[2]},${(aq / 32).toFixed(3)})`; CSSC.set(k, s); } return s; };
  const HEXC = [];
  const rampHex = h => { const q = clamp(Math.round(h * 16), 0, 16); return HEXC[q] || (HEXC[q] = '#' + RAMP[(q * 255 / 16) | 0].map(v => v.toString(16).padStart(2, '0')).join('')); };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const LUT = {};
  const lut = (name, stops) => {
    if (LUT[name]) return LUT[name];
    const st = stops.map(hex), arr = [];
    for (let i = 0; i < 64; i++) {
      const t = i / 63 * (st.length - 1), k = Math.min(st.length - 2, Math.floor(t)), f = t - k, a = st[k], b = st[k + 1];
      arr.push([0, 1, 2].map(j => Math.round(a[j] + (b[j] - a[j]) * f)));
    }
    return LUT[name] = arr;
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const SPR = {};
  const sprites = (name, stops) => {
    if (SPR[name]) return SPR[name];
    const L = lut(name, stops), arr = [];
    for (let i = 0; i < 64; i += 4) {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, rgba(L[i], 1)); g.addColorStop(0.45, rgba(L[i], 0.7)); g.addColorStop(1, rgba(L[i], 0));
      x.fillStyle = g; x.fillRect(0, 0, 32, 32); arr.push(c);
    }
    return SPR[name] = arr;
  };
  const glowSprite = (() => { const m = {}; return col => m[col] || (m[col] = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), h = hex(col);
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, rgba(h, 1)); g.addColorStop(0.55, rgba(h, 0.3)); g.addColorStop(1, rgba(h, 0));
    x.fillStyle = g; x.fillRect(0, 0, 64, 64); return c; })()); })();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'), mobile = matchMedia('(max-width: 768px)');
  // Exact cubic-bezier(.35,.5,.35,1) — the slash's CSS draw curve — so the head sits on the drawn tip.
  const bez = (x1, y1, x2, y2) => {
    const A = (a, b) => 1 - 3 * b + 3 * a, B = (a, b) => 3 * b - 6 * a, C = a => 3 * a;
    const cx = t => ((A(x1, x2) * t + B(x1, x2)) * t + C(x1)) * t, cy = t => ((A(y1, y2) * t + B(y1, y2)) * t + C(y1)) * t, dx = t => 3 * A(x1, x2) * t * t + 2 * B(x1, x2) * t + C(x1);
    return x => { x = Math.min(1, Math.max(0, x)); let t = x; for (let i = 0; i < 6; i++) { const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= (cx(t) - x) / d; } return cy(Math.min(1, Math.max(0, t))); };
  };
  const ease = bez(0.35, 0.5, 0.35, 1);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const active = new Set();
  let raf = 0, last = 0;
  const loop = now => {
    if (now - last < 32) { raf = requestAnimationFrame(loop); return; } // ~30 fps
    const dt = Math.min(0.06, (now - last) / 1000 || 0.033); last = now;
    for (const el of active) el._step(dt);
    raf = active.size ? requestAnimationFrame(loop) : 0;
  };
  const start = el => { active.add(el); if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const stop = el => active.delete(el);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (active.size && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); } });

  class FireEdge extends HTMLElement {
    static observedAttributes = ['active'];
    constructor() {
      super();
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>:host{position:absolute;inset:0;display:block;pointer-events:none;overflow:visible}canvas{position:absolute;display:block;pointer-events:none}</style><canvas></canvas>`;
      this._c = sh.querySelector('canvas'); this._ctx = this._c.getContext('2d');
      this._p = []; this._s = []; this._k = []; this._acc = 0; this._t = Math.random() * 100; this._el = 0; this._run = false; this._W = 0; this._H = 0;
    }
    connectedCallback() {
      this._ro = new ResizeObserver(() => this._resize()); this._ro.observe(this);
      // offscreen or hidden tab → no stepping at all (the shared loop skips us)
      this._vis = true; this._io = new IntersectionObserver(es => { this._vis = es[0].isIntersecting; }, { rootMargin: '80px' }); this._io.observe(this);
      this._resize(); if (this._on) this._start();
    }
    disconnectedCallback() { this._ro.disconnect(); this._io.disconnect(); stop(this); }
    attributeChangedCallback() { if (!this.isConnected) return; this._on ? this._start() : this._kill(); }
    get _on() { const v = this.getAttribute('active'); return v != null && v !== 'false' && v !== '0' && v !== ''; }
    get _o() {
      const g = (n, d) => { const v = this.getAttribute(n); return v == null || v === '' ? d : v; };
      const ds = document.documentElement.dataset, tw = (k, d) => { const v = parseFloat(ds[k]); return isNaN(v) ? d : v; };
      return { mode: g('mode', 'sweep'), delay: +g('delay', 0), duration: +g('duration', 1.2), scale: +g('scale', 12), intensity: +g('intensity', 1), opacity: +g('opacity', 0.85),
        coalGlow: tw('coalGlow', 1), coalDensity: tw('coalDensity', 1),
        blend: g('blend', 'add'), scheme: SCHEMES[g('scheme', 'orange')] || SCHEMES.orange, schemeName: g('scheme', 'orange'), pad: +g('pad', 30),
        x1: +g('x1', 0), y1: +g('y1', 100), x2: +g('x2', 100), y2: +g('y2', 0), coals: g('coals', 'false') !== 'false', sustain: +g('sustain', 0), hold: +g('hold', 1), linger: +g('linger', 0), linear: g('linear', 'false') !== 'false' };
    }
    // Coal bed along the line: irregular charcoal chunks (normalised: f along the line,
    // n across it in flame-scale units) that the head reveals as it passes; each glows
    // white-hot at reveal, cools into a pulsing ember, and occasionally flares.
    _buildCoals() {
      const o = this._o, W = this._W, H = this._H, S = o.scale, R = Math.random;
      const len = Math.hypot((o.x2 - o.x1) / 100 * W, (o.y2 - o.y1) / 100 * H) || 1, step = 0.3 * S / len / Math.max(0.1, o.coalDensity), cells = [];
      for (let f = step * 0.5; f < 1; f += step * (0.9 + 0.2 * R())) { // near-continuous: the coal bed IS the slash now
        const n = 5 + ((R() * 3) | 0), verts = [];
        for (let i = 0; i < n; i++) { const a = i / n * 6.283 + (R() - 0.5) * 0.5, r = (0.2 + 0.16 * R()) * (i % 2 ? 1 : 0.8); verts.push([Math.cos(a) * r * 1.45, Math.sin(a) * r]); }
        cells.push({ f, n: (R() - 0.5) * 0.22, verts, tone: 0.1 + 0.3 * R(), ps: 0.9 + 1.6 * R(), po: R() * 6.28, flareAt: 1.5 + R() * 8, flareDur: 1.5 + R() * 2, born: -1, passed: -1,
          crack: [[(R() - 0.5) * 0.3, -0.2 - 0.1 * R()], [(R() - 0.5) * 0.15, 0.05 * (R() - 0.5)], [(R() - 0.5) * 0.3, 0.2 + 0.1 * R()]] });
      }
      this._coals = cells;
    }
    _drawCoals(ctx, e, tNow, o) {
      const W = this._W, H = this._H, S = o.scale, add = o.blend === 'add';
      const ax = o.x1 / 100 * W, ay = o.y1 / 100 * H, dx = (o.x2 - o.x1) / 100 * W, dy = (o.y2 - o.y1) / 100 * H, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      for (const c of this._coals) {
        if (c.f > e) continue;
        if (c.born < 0) { c.born = tNow; if (!this._coalBorn0) this._coalBorn0 = tNow; } // coals surface under the fire immediately
        const age = tNow - c.born;
        let flare = 0;
        // random per-coal flares (as in the original coals engine): a coal heats up for 1.5–3.5s, then rests 4–16s
        if (age > c.flareAt) { const fu = (age - c.flareAt) / c.flareDur; if (fu > 1) { c.flareAt = age + 4 + Math.random() * 12; c.flareDur = 1.5 + Math.random() * 2; } else flare = Math.pow(Math.sin(fu * Math.PI), 2) * (0.3 + 0.2 * c.tone); }
        const pulse = 0.5 + 0.5 * Math.sin(tNow * c.ps + c.po);
        const settle = smooth(0, 1.2, age);
        const h = clamp((1 - settle) * 0.85 + settle * ((0.3 + 0.1 * pulse) * Math.min(1, 0.5 + 0.5 * o.coalGlow) + flare * Math.min(1.4, o.coalGlow + 0.4)), 0, 1);
        const G = o.coalGlow;
        const cx = ax + dx * c.f + nx * c.n * S, cy = ay + dy * c.f + ny * c.n * S;
        const P = c.verts.map(([vx, vy]) => [cx + (ux * vx + nx * vy) * S, cy + (uy * vx + ny * vy) * S]);
        // soft ambient glow under the coal (skipped once settled and dim — the rim + crack carry the read)
        if (G > 0 && (h > 0.5 || G > 1)) { ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'; ctx.globalAlpha = o.opacity * clamp((h - 0.5 + 0.35 * Math.max(0, G - 1)) * 0.5 * G, 0, 1);
        ctx.drawImage(glowSprite(rampHex(h * 0.72)), cx - 0.9 * S * G, cy - 0.9 * S * G, 1.8 * S * G, 1.8 * S * G); }
        // charcoal body
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]); ctx.closePath();
        const g = 18 + 60 * c.tone; ctx.fillStyle = `rgb(${g * 0.94 | 0},${g * 0.97 | 0},${g * 1.06 | 0})`; ctx.fill();
        // heat through the body + hot rim + crack
        ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
        ctx.fillStyle = rampCss(h * 0.8, clamp((0.2 + h * h * 0.5) * (0.6 + 0.4 * G), 0, 1)); ctx.fill();
        if (h > 0.7) { ctx.fillStyle = rampCss(0.55 + h * 0.35, (h - 0.7) * 2); ctx.fill(); }
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.lineWidth = 1.1; ctx.strokeStyle = rampCss(h * 0.9, 0.25 + h * 0.6); ctx.stroke();
        ctx.beginPath(); c.crack.forEach(([vx, vy], i) => { const px = cx + (ux * vx + nx * vy) * S, py = cy + (uy * vx + ny * vy) * S; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.lineWidth = 1; ctx.strokeStyle = rampCss(0.55 + h * 0.42, 0.3 + h * 0.6); ctx.stroke();
        if (h > 0.55 && (age < 1.2 || flare > 0.15) && Math.random() < 0.01) this._s.push({ x: cx, y: cy - 0.2 * S, vx: (Math.random() - 0.5) * 0.5 * S, vy: -(0.7 + Math.random() * 0.7) * S, life: 0.9 + Math.random() * 1.2, age: 0, r: (0.025 + Math.random() * 0.025) * S, ph: Math.random() * 6.28, fq: 3 + Math.random() * 4 });
      }
    }
    _resize() {
      const W = this.clientWidth, H = this.clientHeight, P = this._o.pad, dpr = 1; // 1× backing store: soft sprites don't need retina pixels and it quarters fill cost
      if (W === this._W && H === this._H && dpr === this._dpr) return;
      this._W = W; this._H = H; this._P = P; this._dpr = dpr;
      this._c.width = (W + 2 * P) * dpr; this._c.height = (H + 2 * P) * dpr;
      Object.assign(this._c.style, { width: (W + 2 * P) + 'px', height: (H + 2 * P) + 'px', left: -P + 'px', top: -P + 'px' });
    }
    _start() {
      this._el = 0; this._t0 = performance.now(); this._acc = 0; this._p = []; this._s = []; this._k = []; this._coals = null; this._burnDone = false; this._coalAt = 0; this._coalBorn0 = 0; this._cc = null; this._trail = []; this._run = true; this._clear();
      if (reduced.matches || mobile.matches) return;
      start(this);
    }
    _kill() { this._run = false; stop(this); this._clear(); }
    _finish() { this._run = false; stop(this); this._clear(); }
    _clear() { const P = this._P || 0; this._ctx.setTransform(1, 0, 0, 1, 0, 0); this._ctx.clearRect(0, 0, this._c.width, this._c.height); void P; }
    // Where the fire lives at progress u: a spawn() sampler in host px + the head point (for glow).
    _front(u, o, t) {
      const W = this._W, H = this._H, S = o.scale, R = Math.random;
      if (o.mode === 'lip') return { spawn: () => [R() * W, H + (R() - 0.5) * 0.2 * S], head: null, rate: 2.6 * W / S };
      if (o.mode === 'line') {
        const es = o.linear ? (x => Math.min(1, Math.max(0, x))) : ease;
        const ax = o.x1 / 100 * W, ay = o.y1 / 100 * H, bx = o.x2 / 100 * W, by = o.y2 / 100 * H, e = es(u), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
        const hx = ax + dx * e, hy = ay + dy * e, headOn = u < 1;
        const du = 0.02, vel = headOn ? (es(Math.min(1, u + du)) - e) / (du * o.duration) : 0, hvx = dx * vel, hvy = dy * vel;
        // after the draw the whole line burns for `linger` s, then dies out
        const lingerK = headOn ? 1 : o.linger > 0 ? 1 - smooth(o.linger * 0.6, o.linger, (u - 1) * o.duration) : 0;
        let fLo = 0; const tr = this._trail; if (headOn) for (let i = tr.length - 1; i >= 0; i--) if (tr[i][0] <= t - o.hold) { fLo = tr[i][1]; break; }
        const span = Math.max(0, e - fLo);
        return { spawn: () => {
          if (headOn && R() < 0.55) { const b = R() * 0.1; return [hx + dx * b + (R() - 0.5) * 0.3 * S, hy + dy * b + (R() - 0.5) * 0.3 * S, hvx * 0.9, hvy * 0.9]; }
          const f = fLo + R() * span; return [ax + dx * f + (R() - 0.5) * 0.35 * S, ay + dy * f + (R() - 0.5) * 0.35 * S, 0, 0];
        }, head: headOn ? [hx, hy] : null, rate: ((headOn ? 36 : 0) + span * L / S * 5) * lingerK };
      }
      const fx = ease(u) * W;
      return { spawn: () => [fx + (R() - 0.5) * 0.4 * S, H * (0.3 + 0.7 * R())], head: [fx, H * 0.7], rate: 32 };
    }
    _step(dt) {
      const o = this._o, S = o.scale, W = this._W, H = this._H, P = this._P, ctx = this._ctx, sc = o.scheme;
      if (!W || !this._run || !this._vis) return;
      this._el = (performance.now() - this._t0) / 1000; this._t += dt; const t = this._t, e = this._el - o.delay;
      if (e < 0) return;
      const u = e / o.duration, done = u >= 1, eu = o.linear ? Math.min(u, 1) : ease(Math.min(u, 1));
      // drive the CSS slash only while drawing (+ one final frame) — not a style invalidation per frame forever
      if (o.mode === 'line' && !this._burnDone) { if (done) this._burnDone = true; }
      if (o.coals && o.mode === 'line' && !this._coals) this._buildCoals();
      if (done && !o.coals && !o.sustain && !this._p.length && !this._s.length && !this._k.length) { this._finish(); return; }
      // lip: ramp in, burn full, then ease down to `sustain` (0 = go out) and hold there while open
      const lingerOut = o.mode === 'line' && done && (u - 1) * o.duration >= (o.linger || 0);
      const env = lingerOut ? 0 : done ? (o.mode === 'line' ? 1 : o.sustain) : o.mode === 'lip' ? smooth(0, 0.08, u) * (1 - (1 - o.sustain) * smooth(0.68, 1, u)) : o.mode === 'line' ? Math.min(1, u / 0.05) : Math.min(1, u / 0.05) * Math.min(1, (1 - u) / 0.08);
      const flick = 0.75 + 0.25 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1) + 0.15 * Math.sin(t * 13.7);
      const wind = 0.25 * Math.sin(t * 1.7) + 0.15 * Math.sin(t * 4.3 + 2);
      if (o.mode === 'line') { this._trail.push([t, eu]); if (this._trail.length > 200) this._trail.splice(0, 50); }
      const F = this._front(Math.min(u, 1), o, t);
      const lifeK = o.mode === 'line' ? 0.7 : 1;
      // spawn flame bodies along the front
      this._acc += dt * F.rate * o.intensity * env * (0.8 + 0.4 * flick);
      while (this._acc > 1) {
        this._acc--;
        const [x, y, hvx = 0, hvy = 0] = F.spawn();
        this._p.push({ x, y, ax: x, vx: (Math.random() - 0.5) * 0.3 * S + hvx, vy: -(1.0 + Math.random() * 0.9) * S + hvy, life: (0.6 + Math.random() * 0.55) * lifeK, age: 0,
          r0: (0.16 + Math.random() * 0.14) * S, ph: Math.random() * 6.28, fq: 6 + Math.random() * 6, hv: hvx });
      }
      const lipScale = o.mode === 'lip' ? Math.max(1, W / 90) : 1;
      if (Math.random() < dt * 1.6 * o.intensity * env * lipScale) {
        const [x, y] = F.spawn();
        this._s.push({ x, y: y - 0.4 * S, vx: (Math.random() - 0.5) * 0.5 * S, vy: -(0.9 + Math.random() * 0.8) * S, life: 1 + Math.random() * 1.2, age: 0, r: (0.025 + Math.random() * 0.03) * S, ph: Math.random() * 6.28, fq: 3 + Math.random() * 4 });
      }
      if (o.blend === 'add' && Math.random() < dt * 2.4 * o.intensity * env * lipScale) { // smoke only on dark grounds — invisible on the light cards, so don't pay for it
        const [x, y] = F.spawn();
        this._k.push({ x, y: y - 0.6 * S, ax: x, vx: (Math.random() - 0.5) * 0.3 * S, vy: -(0.35 + Math.random() * 0.3) * S, life: 1.4 + Math.random() * 1.0, age: 0, r0: 0.35 * S, ph: Math.random() * 6.28, fq: 1.5 + Math.random() * 2, c: (Math.random() * 3) | 0 });
      }
      ctx.setTransform(this._dpr, 0, 0, this._dpr, P * this._dpr, P * this._dpr);
      ctx.clearRect(-P, -P, W + 2 * P, H + 2 * P);
      // Coals render every frame (the throttled-layer approach read as visible stepping in the glow).
      if (this._coals) {
        if (true) {
          if (!this._cc) { this._cc = document.createElement('canvas'); }
          if (this._cc.width !== this._c.width || this._cc.height !== this._c.height) { this._cc.width = this._c.width; this._cc.height = this._c.height; }
          const cc = this._cc.getContext('2d'); cc.setTransform(1, 0, 0, 1, 0, 0); cc.clearRect(0, 0, this._cc.width, this._cc.height);
          cc.setTransform(this._dpr, 0, 0, this._dpr, P * this._dpr, P * this._dpr);
          this._drawCoals(cc, eu, t, o); this._coalAt = t;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.drawImage(this._cc, 0, 0);
        ctx.setTransform(this._dpr, 0, 0, this._dpr, P * this._dpr, P * this._dpr);
      }
      // smoke first (always source-over, cool gray-brown, rises slower + widens)
      ctx.globalCompositeOperation = 'source-over';
      let K = this._k, q = 0;
      for (let i = 0; i < K.length; i++) { const s = K[i]; if ((s.age += dt) < s.life) K[q++] = s; }
      K.length = q;
      for (const s of K) {
        const k = s.age / s.life;
        s.vy -= 0.15 * S * dt; s.vx += (Math.sin(t * s.fq + s.ph) * 0.5 + wind * 0.8) * S * dt; s.vx *= 1 - 1.2 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt;
        const r = s.r0 * (1 + 2.2 * k), a = Math.sin(Math.PI * Math.min(1, k * 1.1)) * 0.22;
        ctx.globalAlpha = o.opacity * a;
        ctx.drawImage(glowSprite(SMOKE[s.c]), s.x - r, s.y - r, 2 * r, 2 * r);
      }
      const add = o.blend === 'add';
      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
      // ambient warm glow following the head
      if (F.head && env > 0) {
        ctx.globalAlpha = o.opacity * (add ? 0.14 : 0.22) * flick * env;
        ctx.drawImage(glowSprite(sc.glow), F.head[0] - 2 * S, F.head[1] - 2 * S, 4 * S, 4 * S);
      }
      const SP = sprites(o.schemeName, sc.stops);
      let Pp = this._p, n = 0;
      for (let i = 0; i < Pp.length; i++) { const p = Pp[i]; if ((p.age += dt) < p.life) Pp[n++] = p; }
      Pp.length = n;
      for (const p of Pp) {
        const k = p.age / p.life;
        p.vy -= 1.6 * S * dt * flick;
        p.vx += (Math.sin(t * p.fq + p.ph) * 1.0 + wind * 1.2 - (p.x - p.ax) / S * 1.5) * S * dt; p.vx *= 1 - 2 * dt; p.ax += (p.hv || 0) * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const r = p.r0 * (1 - 0.8 * k) + 0.015 * S, al = Math.pow(1 - k, 1.3) * 0.75;
        const ci = Math.min(15, Math.max(0, ((0.2 + k * 0.85) * 16) | 0));
        ctx.globalAlpha = o.opacity * al;
        ctx.drawImage(SP[ci], p.x - r, p.y - r, 2 * r, 2 * r);
      }
      // sparks drifting up + swaying
      let Q = this._s, m = 0;
      for (let i = 0; i < Q.length; i++) { const s = Q[i]; if ((s.age += dt) < s.life && s.y > -P) Q[m++] = s; }
      Q.length = m;
      const spk = glowSprite(sc.spark);
      for (const s of Q) {
        const k = s.age / s.life;
        s.vy -= 0.3 * S * dt;
        s.vx += (Math.sin(t * s.fq + s.ph) * 0.8 + wind * 0.6) * S * dt; s.vx *= 1 - 1.5 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt;
        const a = (1 - k) * (0.6 + 0.4 * Math.sin(t * 18 + s.ph)), r = s.r * (1 - 0.5 * k);
        ctx.globalAlpha = o.opacity * a * 0.5;
        ctx.drawImage(spk, s.x - r * 3.5, s.y - r * 3.5, r * 7, r * 7);
        ctx.globalAlpha = o.opacity * a;
        ctx.drawImage(spk, s.x - r * 1.4, s.y - r * 1.4, r * 2.8, r * 2.8);
      }
    }
  }
  customElements.define('fire-edge', FireEdge);
})();
