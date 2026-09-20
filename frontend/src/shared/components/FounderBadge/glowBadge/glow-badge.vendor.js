/* <glow-badge> — founder pin with recolorable enamel, dot-grid texture, and a "prestige" cycle:
   glow swells (inside + beyond the rim), the F lights up, then a sheen sweeps across the F once the glow has died.
   Attributes: scheme (red|orange|yellow|green|blue|indigo|violet|white|black) · glow (0–2, default 1) · speed (s per cycle, default 2.6) · size (px, default 24) · paused */
(() => {
  if (customElements.get('glow-badge')) return;
  const DOT = new URL('./dot-grid.png', import.meta.url).href; /* PATCHED — see PROVENANCE.md */
  const SCHEMES = {
    red:    { h: 355, s: .62, L: [.49, .36, .29, .26], glow: '#ff3a2a' },
    orange: { h: 22,  s: .78, L: [.50, .40, .32, .28], glow: '#ff7a20' },
    yellow: { h: 46,  s: .80, L: [.52, .42, .34, .30], glow: '#f7cf2a' },
    green:  { h: 145, s: .55, L: [.42, .31, .25, .22], glow: '#22d060' },
    blue:   { h: 218, s: .62, L: [.50, .38, .30, .26], glow: '#3a8cff' },
    indigo: { h: 250, s: .55, L: [.50, .38, .30, .26], glow: '#6a4cff' },
    violet: { h: 282, s: .55, L: [.48, .36, .29, .25], glow: '#b040ff' },
    white:  { h: 215, s: .12, L: [.93, .84, .74, .68], glow: '#dfe3ea', light: true },
    black:  { h: 240, s: .08, L: [.30, .18, .11, .08], glow: '#8a8a92' },
  };
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12, c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  };
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const F = 'M8.1 6.2h8.3v3h-4.6v1.9h4.1v2.8h-4.1v3.9h-3.7z';
  const STAR = 'M0 -1.3 Q.25 -.25 1.3 0 Q.25 .25 0 1.3 Q-.25 .25 -1.3 0 Q-.25 -.25 0 -1.3Z';
  const svgFor = name => {
    const sc = SCHEMES[name] || SCHEMES.red, [e0, e1, e2, e3] = sc.L.map(l => hsl(sc.h, sc.s, l));
    const under = hsl(sc.h, sc.s, sc.light ? .55 : .12), rim = hsl(sc.h, Math.min(1, sc.s + .2), .75), g = sc.glow, [nr, ng, nb] = rgb(hsl(sc.h, sc.s, sc.light ? .4 : .2)).map(v => (v / 255).toFixed(3));
    const ink = sc.light ? 0.55 : 0.9;
    return `<svg viewBox="0 0 24 24" width="24" height="24"><defs>
<linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6c25a"/><stop offset="0.22" stop-color="#c49a1e"/><stop offset="0.5" stop-color="#a67c00"/><stop offset="0.8" stop-color="#7a5a08"/><stop offset="1" stop-color="#5c4306"/></linearGradient>
<radialGradient id="e" cx="0.40" cy="0.34" r="0.80"><stop offset="0" stop-color="${e0}"/><stop offset="0.38" stop-color="${e1}"/><stop offset="0.82" stop-color="${e2}"/><stop offset="1" stop-color="${e3}"/></radialGradient>
<pattern id="dg" patternUnits="userSpaceOnUse" x="0.9" y="0.7" width="5.6" height="4.85"><image href="${DOT}" width="5.6" height="4.85" preserveAspectRatio="none"/></pattern>
<radialGradient id="dgm" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0.35"/></radialGradient>
<mask id="dgk"><circle cx="12" cy="12" r="10.9" fill="url(#dgm)"/></mask>
<radialGradient id="pg" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="0.3" stop-color="${g}" stop-opacity="0.9"/><stop offset="0.72" stop-color="${g}" stop-opacity="0.45"/><stop offset="0.93" stop-color="${g}" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0.8"/></radialGradient>
<linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="1"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="0.86" stop-color="#000" stop-opacity="0.28"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>
<radialGradient id="hl" cx="0.34" cy="0.22" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.42"/><stop offset="0.48" stop-color="#fff" stop-opacity="0.06"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="rim" cx="0.72" cy="0.82" r="0.6"><stop offset="0.6" stop-color="${rim}" stop-opacity="0"/><stop offset="0.9" stop-color="${rim}" stop-opacity="0.28"/><stop offset="1" stop-color="${rim}" stop-opacity="0"/></radialGradient>
<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="cp"><circle cx="12" cy="12" r="10.9"/></clipPath>
<clipPath id="fcp"><path d="${F}"/></clipPath>
<filter id="bl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.6"/></filter>
<filter id="fg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.9"/></filter>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2be52"/><stop offset="0.5" stop-color="#c9961c"/><stop offset="1" stop-color="#9c7410"/></linearGradient>
<filter id="n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 ${nr}  0 0 0 0 ${ng}  0 0 0 0 ${nb}  0 0 0 0.16 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
<filter id="l" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="0.5" stdDeviation="0.55" flood-color="#000" flood-opacity="0.42"/></filter>
</defs>
<g filter="url(#l)">
<circle cx="12" cy="12" r="11.8" fill="#1b0f03" fill-opacity="0.55"/>
<circle cx="12" cy="12" r="11.4" fill="url(#w)"/>
<circle cx="12" cy="12" r="10.9" fill="url(#e)"/>
<circle cx="12" cy="12" r="10.9" fill="url(#dg)" mask="url(#dgk)" opacity="0.7"/>
<g id="pl"><circle cx="12" cy="12" r="10.9" fill="url(#pg)"/><circle cx="12" cy="12" r="11.4" fill="none" stroke="${g}" stroke-width="0.9"/></g>
<circle cx="12" cy="12" r="10.9" fill="#fff" filter="url(#n)"/>
<circle cx="12" cy="12" r="10.9" fill="url(#s)"/>
<circle cx="12" cy="12" r="10.9" fill="url(#rim)"/>
<g clip-path="url(#cp)"><ellipse cx="12" cy="7.2" rx="9.6" ry="5.4" fill="url(#sh)"/><ellipse cx="8.6" cy="6.6" rx="4.2" ry="2.6" fill="url(#hl)" filter="url(#bl)" transform="rotate(-28 8.6 6.6)"/></g>
<path id="fh" d="${F}" fill="${g}" filter="url(#fg)"/>
<path d="${F}" transform="translate(0 0.7)" fill="${under}" fill-opacity="${ink}"/>
<path d="${F}" fill="url(#g)" stroke="#5c4306" stroke-width="0.22" stroke-opacity="0.6" stroke-linejoin="round"/>
<path d="${F}" fill="url(#gl)"/>
<path id="fl" d="${F}" fill="#fff"/>
<g clip-path="url(#fcp)"><g transform="rotate(28 12 12)"><path id="sm" d="M8 -6 C 15 4, 15 20, 8 30 L 14 30 C 20 20, 20 4, 14 -6 Z" fill="url(#sg)"/><path id="sm2" d="M10 -6 C 13 6, 13 18, 10 30 L 12 30 C 15 18, 15 6, 12 -6 Z" fill="url(#sg)"/></g></g>
<g id="sp" fill="#fff"><g transform="translate(8.3 6.4)"><path d="${STAR}"/></g><g transform="translate(16.2 9.0) scale(.65)"><path d="${STAR}"/></g><g transform="translate(11.9 17.7) scale(.55)"><path d="${STAR}"/></g></g>
<circle cx="12" cy="12" r="10.75" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="0.3"/>
</g></svg>`;
  };

  class GlowBadge extends HTMLElement {
    static observedAttributes = ['size', 'scheme', 'glow', 'speed'];
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>
:host{display:inline-block;line-height:0;vertical-align:middle;flex:0 0 auto}
#w{position:relative;display:block;width:24px;height:24px}
#h{position:absolute;inset:-42.5%;border-radius:50%;pointer-events:none;background:radial-gradient(circle,var(--g) 0%,var(--g2) 22%,transparent 60%);mix-blend-mode:screen;opacity:0;animation:halo var(--d) linear infinite;will-change:opacity,transform}
#h2{position:absolute;inset:-12.5%;border-radius:50%;pointer-events:none;background:radial-gradient(circle,var(--g) 30%,transparent 70%);filter:blur(2px);opacity:0;animation:halo2 var(--d) linear infinite;will-change:opacity}
svg{position:relative;z-index:1;display:block;width:100%;height:100%;overflow:visible}
#pl,#fl,#fh{opacity:0;animation:enamel var(--d) linear infinite;will-change:opacity}
#fl{animation-name:flight}#fh{animation-name:fhalo}
#sm{transform:translateX(-18px);animation:shimmer var(--d) cubic-bezier(.45,0,.2,1) infinite;will-change:transform}
#sm2{transform:translateX(-18px);animation:shimmer2 var(--d) cubic-bezier(.5,0,.3,1) infinite;will-change:transform}
#sp path{transform-box:fill-box;transform-origin:center;opacity:0;animation:spark var(--d) ease-in-out infinite}
#sp g:nth-child(2) path{animation-name:spark2}#sp g:nth-child(3) path{animation-name:spark3}
:host([paused]) #h,:host([paused]) #h2,:host([paused]) #pl,:host([paused]) #fl,:host([paused]) #fh,:host([paused]) #sm,:host([paused]) #sm2,:host([paused]) #sp path{animation-play-state:paused}
@keyframes halo{0%,100%{opacity:0;transform:scale(.7)}10%{opacity:calc(var(--s)*.09);transform:scale(.78)}20%{opacity:calc(var(--s)*.34);transform:scale(.88)}30%{opacity:calc(var(--s)*.72);transform:scale(1)}38%{opacity:calc(var(--s)*.95);transform:scale(1.08)}46%{opacity:calc(var(--s)*.72);transform:scale(1.14)}53%{opacity:calc(var(--s)*.28);transform:scale(1.18)}58%{opacity:0;transform:scale(1.2)}}
@keyframes halo2{0%,100%{opacity:0}10%{opacity:calc(var(--s)*.08)}20%{opacity:calc(var(--s)*.32)}30%{opacity:calc(var(--s)*.68)}38%{opacity:calc(var(--s)*.9)}46%{opacity:calc(var(--s)*.68)}53%{opacity:calc(var(--s)*.26)}58%{opacity:0}}
@keyframes enamel{0%,100%{opacity:0}10%{opacity:calc(var(--s)*.09)}20%{opacity:calc(var(--s)*.36)}30%{opacity:calc(var(--s)*.76)}38%{opacity:calc(var(--s)*1)}46%{opacity:calc(var(--s)*.76)}53%{opacity:calc(var(--s)*.3)}58%{opacity:0}}
@keyframes flight{0%,100%{opacity:0}10%{opacity:calc(var(--s)*.04)}20%{opacity:calc(var(--s)*.16)}30%{opacity:calc(var(--s)*.34)}38%{opacity:calc(var(--s)*.45)}46%{opacity:calc(var(--s)*.34)}53%{opacity:calc(var(--s)*.13)}58%{opacity:0}}
@keyframes fhalo{0%,100%{opacity:0}10%{opacity:calc(var(--s)*.08)}20%{opacity:calc(var(--s)*.32)}30%{opacity:calc(var(--s)*.68)}38%{opacity:calc(var(--s)*.9)}46%{opacity:calc(var(--s)*.68)}53%{opacity:calc(var(--s)*.26)}58%{opacity:0}}
@keyframes shimmer{0%,60%{transform:translateX(-18px)}82%,100%{transform:translateX(18px)}}
@keyframes shimmer2{0%,65%{transform:translateX(-18px)}88%,100%{transform:translateX(18px)}}
@keyframes spark{0%,64%{opacity:0;transform:scale(.2) rotate(0deg)}70%{opacity:1;transform:scale(1) rotate(45deg)}78%,100%{opacity:0;transform:scale(.2) rotate(90deg)}}
@keyframes spark2{0%,72%{opacity:0;transform:scale(.2)}78%{opacity:.95;transform:scale(1) rotate(45deg)}86%,100%{opacity:0;transform:scale(.2) rotate(90deg)}}
@keyframes spark3{0%,80%{opacity:0;transform:scale(.2)}85%{opacity:.9;transform:scale(1) rotate(45deg)}92%,100%{opacity:0;transform:scale(.2) rotate(90deg)}}
</style><div id="w"><div id="h"></div><div id="h2"></div></div>`;
      this._w = this.shadowRoot.querySelector('#w');
    }
    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this.isConnected) this._render(); }
    _render() {
      const g = (n, d) => { const v = this.getAttribute(n); return v == null || v === '' ? d : v; };
      const scheme = g('scheme', 'red'), size = +g('size', 24) || 24, glow = +g('glow', 1), speed = +g('speed', 2.6) || 2.6;
      const sc = SCHEMES[scheme] || SCHEMES.red, [r, gg, b] = rgb(sc.glow);
      if (this._scheme !== scheme) { this._w.querySelector('svg')?.remove(); this._w.insertAdjacentHTML('beforeend', svgFor(scheme)); this._scheme = scheme; }
      this._w.style.width = this._w.style.height = size + 'px';
      this._w.style.setProperty('--g', `rgba(${r},${gg},${b},1)`);
      this._w.style.setProperty('--g2', `rgba(${r},${gg},${b},.55)`);
      this._w.style.setProperty('--s', glow);
      this._w.style.setProperty('--d', speed + 's');
      if (!this._delay) this._delay = '0s'; /* PATCHED — every pin pulses in sync; see PROVENANCE.md */
      for (const el of this._w.querySelectorAll('#h,#h2,#pl,#fl,#fh,#sm,#sm2,#sp path')) el.style.animationDelay = this._delay;
    }
  }
  customElements.define('glow-badge', GlowBadge);
})();
