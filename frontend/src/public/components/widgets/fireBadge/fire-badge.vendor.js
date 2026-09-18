/* <fire-badge> — wraps any badge element and burns a small, semi-transparent particle fire behind it.
   Attributes: badge (render the founder pin itself, no slotted content needed) · scheme (red|orange|yellow|green|blue|indigo|violet|white|black) · intensity (0.3–2, default 1) · opacity (0–1, default .75) · sparks (true|false) · size (px, optional; else measured from the slotted badge) */
(() => {
  if (customElements.get('fire-badge')) return;
  const SCHEMES = {
    red:    { stops: ['#ffe3e0', '#ff7a6a', '#ee2a1a', '#8e1008', '#2a0404'], spark: '#ffb3a8', glow: '#ff3a2a' },
    orange: { stops: ['#fff3d8', '#ffb347', '#ff6a12', '#a63a08', '#301004'], spark: '#ffd28a', glow: '#ff7a20' },
    yellow: { stops: ['#fffbe0', '#ffe66a', '#f5c518', '#9c7408', '#302204'], spark: '#fff2a8', glow: '#f7cf2a' },
    green:  { stops: ['#e8ffee', '#7cf5a0', '#1fc85a', '#0c6e30', '#03280f'], spark: '#b8ffcc', glow: '#22d060' },
    blue:   { stops: ['#e4f2ff', '#78c4ff', '#2a7ef5', '#1438a8', '#060c34'], spark: '#bfe3ff', glow: '#3a8cff' },
    indigo: { stops: ['#ecebff', '#9c92ff', '#5a3ee8', '#2c1690', '#0c0630'], spark: '#c9c2ff', glow: '#6a4cff' },
    violet: { stops: ['#fbe8ff', '#dc8cff', '#a028f0', '#5c0e98', '#1c0430'], spark: '#ecc4ff', glow: '#b040ff' },
    white:  { stops: ['#ffffff', '#f2f4f8', '#c8ccd6', '#7a808c', '#2a2d34'], spark: '#ffffff', glow: '#dfe3ea' },
    black:  { stops: ['#8a8a92', '#3c3c44', '#1a1a20', '#0c0c10', '#000000'], spark: '#b0b0b8', glow: '#2a2a32', dark: true },
  };

  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const LUT = {};
  const lut = name => {
    if (LUT[name]) return LUT[name];
    const st = (SCHEMES[name] || SCHEMES.orange).stops.map(hex), arr = [];
    for (let i = 0; i < 64; i++) {
      const t = i / 63 * (st.length - 1), k = Math.min(st.length - 2, Math.floor(t)), f = t - k, a = st[k], b = st[k + 1];
      arr.push([0, 1, 2].map(j => Math.round(a[j] + (b[j] - a[j]) * f)));
    }
    return LUT[name] = arr;
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  // pre-rendered soft discs: SPR[scheme][colorIndex] is a 32px canvas of a radial falloff in that color
  const SPR = {};
  const sprites = name => {
    if (SPR[name]) return SPR[name];
    const L = lut(name), arr = [];
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
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const all = new Set(), active = new Set();
  let raf = 0, last = 0;
  const loop = now => {
    if (now - last < 30) { raf = requestAnimationFrame(loop); return; }
    const dt = Math.min(0.06, (now - last) / 1000 || 0.033); last = now;
    for (const el of active) el._step(dt);
    raf = active.size ? requestAnimationFrame(loop) : 0;
  };
  const start = el => { active.add(el); if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const stop = el => active.delete(el);
  document.addEventListener('visibilitychange', () => all.forEach(el => el._sync()));

  class FireBadge extends HTMLElement {
    static observedAttributes = ['size', 'badge'];
    constructor() {
      super();
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>:host{display:inline-block;line-height:0;vertical-align:middle;flex:0 0 auto}#w{position:relative;display:block}canvas{position:absolute;pointer-events:none;z-index:0}::slotted(*),#w>svg{position:relative;z-index:1;display:block}</style><div id="w"><canvas></canvas><slot></slot></div>`;
      this._w = sh.querySelector('#w');
      this._badgeSvg = `<svg viewBox="0 0 24 24" width="24" height="24"><defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6c25a"/><stop offset="0.22" stop-color="#c49a1e"/><stop offset="0.5" stop-color="#a67c00"/><stop offset="0.8" stop-color="#7a5a08"/><stop offset="1" stop-color="#5c4306"/></linearGradient><radialGradient id="e" cx="0.40" cy="0.34" r="0.80"><stop offset="0" stop-color="#c0393f"/><stop offset="0.38" stop-color="#9a2029"/><stop offset="0.82" stop-color="#7a1a24"/><stop offset="1" stop-color="#6f1620"/></radialGradient><radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#2a0308" stop-opacity="0"/><stop offset="0.86" stop-color="#2a0308" stop-opacity="0.32"/><stop offset="1" stop-color="#1a0205" stop-opacity="0.75"/></radialGradient><radialGradient id="hl" cx="0.34" cy="0.22" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.42"/><stop offset="0.48" stop-color="#fff" stop-opacity="0.06"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient><radialGradient id="rim" cx="0.72" cy="0.82" r="0.6"><stop offset="0.6" stop-color="#ff8a7a" stop-opacity="0"/><stop offset="0.9" stop-color="#ff9a8a" stop-opacity="0.28"/><stop offset="1" stop-color="#ffb0a0" stop-opacity="0"/></radialGradient><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/></linearGradient><clipPath id="cp"><circle cx="12" cy="12" r="10.9"/></clipPath><filter id="bl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.6"/></filter><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2be52"/><stop offset="0.5" stop-color="#c9961c"/><stop offset="1" stop-color="#9c7410"/></linearGradient><filter id="n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.05  0 0 0 0 0.07  0 0 0 0.16 0"/><feComposite in2="SourceGraphic" operator="in"/></filter><filter id="l" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="0.5" stdDeviation="0.55" flood-color="#000" flood-opacity="0.42"/></filter></defs><g filter="url(#l)"><circle cx="12" cy="12" r="11.8" fill="#1b0f03" fill-opacity="0.55"/><circle cx="12" cy="12" r="11.4" fill="url(#w)"/><circle cx="12" cy="12" r="10.9" fill="url(#e)"/><circle cx="12" cy="12" r="10.9" fill="#fff" filter="url(#n)"/><circle cx="12" cy="12" r="10.9" fill="url(#s)"/><circle cx="12" cy="12" r="10.9" fill="url(#rim)"/><g clip-path="url(#cp)"><ellipse cx="12" cy="7.2" rx="9.6" ry="5.4" fill="url(#sh)"/><ellipse cx="8.6" cy="6.6" rx="4.2" ry="2.6" fill="url(#hl)" filter="url(#bl)" transform="rotate(-28 8.6 6.6)"/></g><path d="M8.1 6.2h8.3v3h-4.6v1.9h4.1v2.8h-4.1v3.9h-3.7z" transform="translate(0 0.7)" fill="#35080f" fill-opacity="0.9"/><path d="M8.1 6.2h8.3v3h-4.6v1.9h4.1v2.8h-4.1v3.9h-3.7z" fill="url(#g)" stroke="#5c4306" stroke-width="0.22" stroke-opacity="0.6" stroke-linejoin="round"/><path d="M8.1 6.2h8.3v3h-4.6v1.9h4.1v2.8h-4.1v3.9h-3.7z" fill="url(#gl)"/><circle cx="12" cy="12" r="10.75" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="0.3"/></g></svg>`;
      this._c = sh.querySelector('canvas'); this._ctx = this._c.getContext('2d');
      this._p = []; this._s = []; this._acc = 0; this._t = Math.random() * 100; this._vis = true; this._S = 0;
    }
    connectedCallback() {
      all.add(this);
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this._resize()));
      if (!this.getAttribute('size')) this._ro.observe(this);
      this._io = new IntersectionObserver(e => { this._vis = e[0].isIntersecting; this._sync(); }); this._io.observe(this);
      this._badge(); this._resize(); this._sync();
    }
    disconnectedCallback() { all.delete(this); this._ro.disconnect(); this._io.disconnect(); stop(this); }
    attributeChangedCallback() { if (this.isConnected) { this._badge(); this._resize(); } }
    _badge() {
      const slot = this.shadowRoot.querySelector('slot');
      if (slot && this.hasAttribute('badge') && this.getAttribute('badge') !== 'false') slot.outerHTML = this._badgeSvg;
    }
    get _opts() {
      const g = (n, d) => { const v = this.getAttribute(n); return v == null || v === '' ? d : v; };
      return { scheme: g('scheme', 'orange'), intensity: +g('intensity', 1) || 1, opacity: +g('opacity', 0.75), sparks: String(g('sparks', 'true')) !== 'false' };
    }
    _sync() {
      if (reduced.matches) { stop(this); for (let i = 0; i < 50; i++) this._step(1 / 40); return; }
      (this._vis && !document.hidden) ? start(this) : stop(this);
    }
    _resize() {
      const attr = +this.getAttribute('size');
      const S = attr || this._w.clientWidth || 24, dpr = Math.min(devicePixelRatio || 1, S < 40 ? 1 : 1.5);
      if (attr) {
        this._w.style.width = this._w.style.height = attr + 'px';
        const svg = this._w.querySelector('svg'); if (svg) { svg.setAttribute('width', attr); svg.setAttribute('height', attr); }
      }
      if (S === this._S && dpr === this._dpr) return;
      this._S = S; this._dpr = dpr;
      const W = 3 * S, H = 4 * S;
      this._c.width = W * dpr; this._c.height = H * dpr;
      Object.assign(this._c.style, { width: W + 'px', height: H + 'px', left: -S + 'px', top: -2.4 * S + 'px' });
    }
    _step(dt) {
      const o = this._opts, S = this._S, R = S / 2, cx = 1.5 * S, cy = 2.9 * S, ctx = this._ctx, sc = SCHEMES[o.scheme] || SCHEMES.orange;
      if (!S) return;
      this._t += dt; const t = this._t;
      const flick = 0.75 + 0.25 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1) + 0.15 * Math.sin(t * 13.7);
      const wind = 0.25 * Math.sin(t * 1.7) + 0.15 * Math.sin(t * 4.3 + 2);
      // spawn flame bodies on the lower rim of the badge, biased to the bottom centre
      this._acc += dt * 75 * o.intensity * (0.8 + 0.4 * flick);
      while (this._acc > 1) {
        this._acc--;
        const u = Math.random() * 2 - 1, a = Math.PI / 2 + u * Math.abs(u) * 0.75 * Math.PI;
        this._p.push({ x: cx + 0.85 * R * Math.cos(a), y: cy + 0.85 * R * Math.sin(a), vx: (Math.random() - 0.5) * 0.3 * S,
          vy: -(1.0 + Math.random() * 0.9) * S * (1 - 0.45 * Math.abs(u)), life: 0.6 + Math.random() * 0.55, age: 0,
          r0: (0.16 + Math.random() * 0.14) * S, ph: Math.random() * 6.28, fq: 6 + Math.random() * 6 });
      }
      if (o.sparks && Math.random() < dt * 1.6 * o.intensity) {
        this._s.push({ x: cx + (Math.random() - 0.5) * 1.2 * R, y: cy - R * (0.6 + Math.random() * 0.8), vx: (Math.random() - 0.5) * 0.4 * S,
          vy: -(0.8 + Math.random() * 0.7) * S, life: 1 + Math.random() * 1.2, age: 0, r: (0.025 + Math.random() * 0.03) * S, ph: Math.random() * 6.28, fq: 3 + Math.random() * 4 });
      }
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, 3 * S, 4 * S);
      ctx.globalCompositeOperation = sc.dark ? 'source-over' : 'lighter';
      // ambient glow behind the badge
      ctx.globalAlpha = o.opacity * 0.1 * flick;
      ctx.drawImage(glowSprite(sc.glow), cx - 1.25 * S, cy - 1.25 * S, 2.5 * S, 2.5 * S);
      const SP = sprites(o.scheme);
      // flame bodies
      let P = this._p, n = 0;
      for (let i = 0; i < P.length; i++) { const p = P[i]; if ((p.age += dt) < p.life) P[n++] = p; }
      P.length = n;
      for (const p of P) {
        const k = p.age / p.life;
        p.vy -= 1.6 * S * dt * flick;
        p.vx += (Math.sin(t * p.fq + p.ph) * 1.0 + wind * 1.2 - (p.x - cx) / S * 1.5) * S * dt; p.vx *= 1 - 2 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const r = p.r0 * (1 - 0.8 * k) + 0.015 * S, al = Math.pow(1 - k, 1.3) * 0.75;
        const ci = Math.min(15, Math.max(0, ((0.2 + k * 0.85 + 0.1 * Math.abs(p.x - cx) / R) * 16) | 0));
        ctx.globalAlpha = o.opacity * al;
        ctx.drawImage(SP[ci], p.x - r, p.y - r, 2 * r, 2 * r);
      }
      // sparks that trail off upward
      const sp = hex(sc.spark);
      let Q = this._s, m = 0;
      for (let i = 0; i < Q.length; i++) { const s = Q[i]; if ((s.age += dt) < s.life && s.y > -s.r) Q[m++] = s; }
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
  customElements.define('fire-badge', FireBadge);
})();
