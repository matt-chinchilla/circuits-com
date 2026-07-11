// csFx.ts — shared effects engine for the sponsor boards.
//
// Verbatim TS port of the design prototype's CsFx.jsx (window.* globals →
// ES exports; React.useState/Ref/Effect → named imports). EVERY numeric
// constant, draw call, composition order, easing and timing is preserved 1:1
// from the prototype — do NOT round, "improve", or refactor the math.
//
//  • mountTileField(canvas, board) — the "alive" PCB tile field, rendered on a
//    SINGLE <canvas> (one GPU layer, not 900 DOM nodes). Draws the dot grid;
//    tiles near the cursor rise in fake-3D, random tiles "breathe" up/down,
//    and wave() ripples a literal flip wave out from a point. Returns an api
//    { setCursor, clearCursor, wave, refreshColor, destroy }.
//  • brandVars(primary, secondary) — CSS-var overrides that re-skin a board.
//    (Brand-color EXTRACTION from a logo lives in @shared/utils/brandPalette
//    now — shared with the admin sponsor form; this file only re-skins.)
//  • CsCopy — click-to-copy affordance (shared by both banners).
//  • csTelHref — tel: href normalizer.
//
// NOTE: the prototype's energizePulse (a cheap radial light-sweep helper) is
// NOT ported — it is unused by the wave path. The flip wave is driven entirely
// by mountTileField().wave(). (The .csb-pulse element + keyframes are kept in
// the stylesheet but never triggered, exactly as in the prototype.)

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

interface Tile {
  cx: number;
  cy: number;
  ph: number;
  sp: number;
  amp: number;
  br: boolean;
}

export interface TileField {
  setCursor(x: number, y: number): void;
  clearCursor(): void;
  wave(ox: number, oy: number): void;
  refreshColor(): void;
  setEmblem(img: HTMLImageElement, cx: number, cy: number, size: number): void;
  clearEmblem(): void;
  destroy(): void;
}

/* ── Canvas tile field ──────────────────────────────────────────────────
   ONE canvas, ~hundreds of tiles drawn per frame (cheap fills, single GPU
   layer — the DOM-grid approach was what lagged). Three behaviours compose:
     • cursor dome  — tiles near the pointer rise in fake-3D (+ parallax),
     • breathing    — a random subset gently floats up/down forever,
     • flip wave    — wave() ripples a literal tile-flip out from a point.
   Pauses when offscreen / tab hidden / reduced-motion. */
export function mountTileField(canvas: HTMLCanvasElement, board: HTMLElement): TileField {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const GAP = 19; // tile pitch (px)
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0,
    H = 0,
    cols = 0,
    rows = 0,
    tiles: Tile[] = [];
  let raf = 0,
    running = false,
    visible = true;
  const cursor = { x: -9999, y: -9999, on: false };
  let waveState: { ox: number; oy: number; t0: number; maxR: number } | null = null; // expanding-ring color wave
  // Snapshot of the PRE-energize surface, kept so the new color can spread out
  // from the logo as a ring (old outside the ring, new inside).
  const pcbOld = document.createElement('canvas');
  const pgOld = pcbOld.getContext('2d') as CanvasRenderingContext2D;
  // Tiles are CHUNKS OF THE BOARD SURFACE lifting off — drawn in the board's
  // own color (lit on top, dark underside), never gold. Colors read from
  // --board-2 so they track brand takeovers.
  const col: {
    dot: string;
    dark: [number, number, number];
    acc: [number, number, number];
    glow: [number, number, number];
    g1: [number, number, number];
    g2: [number, number, number];
  } = {
    dot: 'rgba(150,160,166,.15)',
    dark: [8, 12, 11],
    acc: [232, 194, 82],
    glow: [232, 194, 82],
    g1: [13, 44, 30],
    g2: [10, 30, 22],
  };
  // Static PCB texture, drawn ONCE onto an offscreen canvas; tiles carry slices
  // of it so the board pattern is printed on the tiles and lifts WITH them.
  const pcb = document.createElement('canvas');
  const pg = pcb.getContext('2d') as CanvasRenderingContext2D;
  let pcbReady = false;
  // Pre-rendered accent underglow sprite (drawn with one cheap drawImage per
  // tile instead of a per-frame createRadialGradient — keeps hover at 60fps).
  const glow = document.createElement('canvas');
  glow.width = glow.height = 96;
  const glctx = glow.getContext('2d') as CanvasRenderingContext2D;
  let glowReady = false;
  const buildGlow = () => {
    const S = 96,
      a = col.glow;
    glctx.clearRect(0, 0, S, S);
    const gr = glctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
    gr.addColorStop(0, `rgba(${a[0]},${a[1]},${a[2]},1)`);
    gr.addColorStop(0.5, `rgba(${a[0]},${a[1]},${a[2]},.32)`);
    gr.addColorStop(1, `rgba(${a[0]},${a[1]},${a[2]},0)`);
    glctx.fillStyle = gr;
    glctx.fillRect(0, 0, S, S);
    glowReady = true;
  };
  let circuitImg: HTMLImageElement | null = null; // rasterized snapshot of the REAL CircuitTraces vectors

  // Optional emblem (e.g. the open-slot upload icon) composited INTO the board
  // surface so it fragments into tiles exactly like the PCB when tiles rise.
  let emblem: { img: HTMLImageElement; cx: number; cy: number; size: number } | null = null; // logical px
  const drawEmblem = () => {
    if (!emblem || !emblem.img || !emblem.img.complete || !emblem.img.naturalWidth) return;
    const s = emblem.size,
      px = Math.round(s * dpr);
    const tc = document.createElement('canvas');
    tc.width = px;
    tc.height = px;
    const tx = tc.getContext('2d') as CanvasRenderingContext2D;
    tx.drawImage(emblem.img, 0, 0, px, px);
    tx.globalCompositeOperation = 'source-in'; // tint to the live accent
    tx.fillStyle = `rgba(${col.acc[0]},${col.acc[1]},${col.acc[2]},.92)`;
    tx.fillRect(0, 0, px, px);
    pg.drawImage(tc, emblem.cx - s / 2, emblem.cy - s / 2, s, s);
  };

  // Freeze the actual CircuitTraces SVG (the pre-existing vectors) to a static
  // bitmap with its current accent colors inlined, then print it on the tiles.
  const snapshotCircuit = () => {
    const svg = board.querySelector('.csb-circuit svg');
    if (!svg) {
      buildPCB();
      return;
    }
    const cs = getComputedStyle(svg);
    const clone = svg.cloneNode(true) as SVGElement;
    // The static-variant CircuitTraces draws its traces via the CSS-module rule
    // `.circuitTraces.static .trace { stroke-dashoffset: 0 }`. That rule lives in
    // a stylesheet the serialized standalone SVG can't carry, so each path would
    // fall back to its `stroke-dashoffset="1200"` presentation attribute (fully
    // un-drawn) → a blank snapshot: the board paints its dot-grid but NO traces.
    // Neutralize the draw offset on the clone so the raster shows the full board.
    clone.querySelectorAll('[stroke-dasharray]').forEach((p) => {
      p.removeAttribute('stroke-dasharray');
      p.removeAttribute('stroke-dashoffset');
    });
    [
      '--trace-color',
      '--electron-color',
      '--node-color',
      '--ic-body-fill',
      '--ic-body-stroke',
      '--ic-pad-fill',
      '--trace-glow',
    ].forEach((v) => {
      const val = cs.getPropertyValue(v);
      if (val) clone.style.setProperty(v, val.trim());
    });
    clone.setAttribute('width', '1200');
    clone.setAttribute('height', '400');
    let xml: string;
    try {
      xml = new XMLSerializer().serializeToString(clone);
    } catch {
      buildPCB();
      return;
    }
    const img = new Image();
    img.onload = () => {
      circuitImg = img;
      buildPCB();
    };
    img.onerror = () => {
      circuitImg = null;
      buildPCB();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    try {
      const svgEl = svg as SVGSVGElement;
      svgEl.pauseAnimations && svgEl.pauseAnimations();
    } catch {
      /* hidden source — stop its SMIL */
    }
  };

  // Resolve ANY CSS color (hex / color-mix / oklab) to true sRGB bytes via a
  // 1×1 canvas readback — string-parsing fails on the oklab() that color-mix
  // serializes to after a brand takeover.
  const pcv = document.createElement('canvas');
  pcv.width = pcv.height = 1;
  const pctx = pcv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const resolveRGB = (cssColor: string): [number, number, number] => {
    pctx.clearRect(0, 0, 1, 1);
    pctx.fillStyle = '#000';
    pctx.fillStyle = cssColor;
    pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const refreshColor = () => {
    const p = document.createElement('span');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--board-2)';
    board.appendChild(p);
    const b = resolveRGB(getComputedStyle(p).color);
    board.removeChild(p);
    // Lifted chunk keeps the SAME surface color (no lightening). Underside is
    // a darker shade. g1/g2 are the board-gradient endpoints painted on canvas.
    col.g2 = b;
    col.dark = [Math.round(b[0] * 0.42), Math.round(b[1] * 0.42), Math.round(b[2] * 0.42)];
    const pb1 = document.createElement('span');
    pb1.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--board-1)';
    board.appendChild(pb1);
    col.g1 = resolveRGB(getComputedStyle(pb1).color);
    board.removeChild(pb1);
    const pa = document.createElement('span');
    pa.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--gold)';
    board.appendChild(pa);
    col.acc = resolveRGB(getComputedStyle(pa).color);
    board.removeChild(pa);
    // Dot grid follows the SECONDARY (accent) color. Darkened (×0.3 + 8) so an
    // UNBRANDED board keeps a similar resting luminance. Computed AFTER the
    // --gold probe so it reads the fresh accent, not the previous refresh's.
    const a = col.acc;
    col.dot = `rgba(${Math.round(a[0] * 0.3 + 8)},${Math.round(a[1] * 0.3 + 8)},${Math.round(a[2] * 0.3 + 8)},.22)`;
    // Lifted-tile underglow is PINNED to the stock board accent: --underglow is
    // NEVER set by brandVars, so the glow sprite is identical for every
    // sponsorship (branded or steel) and never follows a takeover.
    const pu = document.createElement('span');
    pu.style.cssText = 'position:absolute;left:-9999px;top:0;color:var(--underglow)';
    board.appendChild(pu);
    col.glow = resolveRGB(getComputedStyle(pu).color);
    board.removeChild(pu);
    buildGlow();
  };

  // Build the FULL opaque board surface on the offscreen canvas: board
  // gradient + faint dot grid + the REAL CircuitTraces vectors. The visible
  // board is now this canvas (so .csbA can be transparent and lifted-tile
  // holes reveal the element BEHIND the banner).
  const buildPCB = () => {
    pcb.width = Math.max(1, Math.round(W * dpr));
    pcb.height = Math.max(1, Math.round(H * dpr));
    pg.setTransform(dpr, 0, 0, dpr, 0, 0);
    pg.clearRect(0, 0, W, H);
    const g1 = col.g1,
      g2 = col.g2;
    const grad = pg.createLinearGradient(0, 0, W * 0.4, H); // ~158deg
    grad.addColorStop(0, `rgb(${g2[0]},${g2[1]},${g2[2]})`);
    grad.addColorStop(0.6, `rgb(${g1[0]},${g1[1]},${g1[2]})`);
    grad.addColorStop(1, `rgb(${g2[0]},${g2[1]},${g2[2]})`);
    pg.fillStyle = grad;
    pg.fillRect(0, 0, W, H);
    pg.fillStyle = col.dot;
    for (let y = 0; y <= rows; y++)
      for (let x = 0; x <= cols; x++) {
        pg.beginPath();
        pg.arc(x * GAP, y * GAP, 1.0, 0, 6.2832);
        pg.fill();
      }
    if (circuitImg) {
      const ir = 1200 / 400,
        br = W / Math.max(1, H);
      let dw: number, dh: number;
      if (br > ir) {
        dw = W;
        dh = W / ir;
      } else {
        dh = H;
        dw = H * ir;
      }
      pg.globalAlpha = 0.85;
      pg.drawImage(circuitImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      pg.globalAlpha = 1;
    }
    drawEmblem();
    pcbReady = true;
  };

  const resize = () => {
    const r = board.getBoundingClientRect();
    if (!r.width || !r.height) return;
    W = r.width;
    H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    cols = Math.ceil(W / GAP) + 1;
    rows = Math.ceil(H / GAP) + 1;
    tiles = [];
    for (let r2 = 0; r2 < rows; r2++)
      for (let c = 0; c < cols; c++) {
        tiles.push({
          cx: c * GAP + GAP / 2,
          cy: r2 * GAP + GAP / 2, // CELL CENTER
          ph: Math.random() * Math.PI * 2,
          sp: 0.5 + Math.random() * 0.7,
          amp: 0.35 + Math.random() * 0.6,
          br: Math.random() < 0.03, // sparse shimmer participants
        });
      }
    refreshColor();
    buildPCB();
    snapshotCircuit();
  };

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  const drawTile = (tile: Tile, z: number, flip: number) => {
    const ox0 = tile.cx - GAP / 2,
      oy0 = tile.cy - GAP / 2;
    // SEE-THROUGH: clear the board surface here so the element BEHIND the
    // banner shows through the hole the tile lifted from.
    // SEE-THROUGH: punch a ROUNDED hole (matching the tile's rounded slab) so
    // the element behind the banner shows through, with no sharp corner gaps.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    roundRect(ox0, oy0, GAP, GAP, 2);
    ctx.fill();
    ctx.restore();
    // rounded recess inner-edge shadow for depth
    ctx.save();
    ctx.strokeStyle = `rgba(0,0,0,${0.22 + 0.26 * Math.min(1, z + flip)})`;
    ctx.lineWidth = 1.6;
    roundRect(ox0 + 0.9, oy0 + 0.9, GAP - 1.8, GAP - 1.8, 1.8);
    ctx.stroke();
    ctx.restore();
    const px = tile.cx,
      py = tile.cy; // lift straight up — no cursor parallax shove
    const lift = z * 13;
    let w = GAP,
      face = 0;
    if (flip > 0.001) {
      const ang = flip * Math.PI * 2;
      w = GAP * Math.abs(Math.cos(ang));
      face = Math.cos(ang) < 0 ? 1 : 0;
    }
    const dx = px - w / 2,
      dy = py - lift - GAP / 2;
    const lvl = Math.min(1, z + flip);
    const ext = 1.5 + lift * 0.45; // extruded thickness (depth) — grows with lift
    // 1) UNDERGLOW — accent light leaking from under the lifted tile, spilling
    //    onto neighbours. Cached sprite + one drawImage (cheap → snappy hover).
    if (glowReady && lvl > 0.04) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, 0.46 * lvl);
      const gs = GAP * 3.8;
      ctx.drawImage(glow, px - gs / 2, py + ext - gs / 2, gs, gs);
      ctx.restore();
    }
    // 2) DEPTH — the extruded side wall (darker), drawn down-right of the top
    //    face; it also casts the soft drop shadow.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.5 * lvl})`;
    ctx.shadowBlur = 3 + lift * 0.8;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2 + lift * 0.5;
    const wall = face
      ? col.dark
      : [Math.round(col.g2[0] * 0.5), Math.round(col.g2[1] * 0.5), Math.round(col.g2[2] * 0.5)];
    ctx.fillStyle = `rgb(${wall[0]},${wall[1]},${wall[2]})`;
    roundRect(dx + ext * 0.35, dy + ext, w, GAP, 2);
    ctx.fill();
    ctx.restore();
    // 3) TOP FACE — same color as the resting surface (no brightening).
    if (face) {
      const d = col.dark;
      ctx.fillStyle = `rgb(${d[0]},${d[1]},${d[2]})`;
      roundRect(dx, dy, w, GAP, 2);
      ctx.fill();
    } else if (pcbReady) {
      ctx.save();
      roundRect(dx, dy, w, GAP, 2);
      ctx.clip();
      ctx.drawImage(pcb, ox0 * dpr, oy0 * dpr, GAP * dpr, GAP * dpr, dx, dy, w, GAP);
      ctx.restore();
    }
  };

  // One ring of flipping tiles at the wavefront — flips 0→180° as the ring
  // reaches it, revealing the NEW surface slice on the back half. Carries the
  // same extruded depth + accent underglow as the hover-lift tiles.
  const drawFlipTile = (tile: Tile, p: number) => {
    const ox0 = tile.cx - GAP / 2,
      oy0 = tile.cy - GAP / 2;
    const ang = p * Math.PI; // 0 → 180°
    const w = GAP * Math.abs(Math.cos(ang)); // squish edge-on at 90°
    if (w < 0.5) return;
    const lvl = Math.sin(ang); // 0 at ends, 1 mid-flip
    const lift = lvl * 13;
    const ext = 1.5 + lift * 0.5; // extruded thickness (depth)
    const px = tile.cx,
      py = tile.cy;
    const dx = px - w / 2,
      dy = py - lift - GAP / 2;
    const face = ang > Math.PI / 2 ? 1 : 0; // past 90° → showing the back/new side
    const src = face ? pcb : pcbOld; // new surface on the back half
    // SHADOW ONLY (no underglow, no bright socket) — a dark contact shadow on
    // the surface beneath grounds the lift; the dark surfaces + slow, varied
    // flip angles read as individual tiles, never a band of light.
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.3 * lvl})`;
    ctx.beginPath();
    ctx.ellipse(px + 1.5, oy0 + GAP * 0.7, w * 0.55, 2.6, 0, 0, 6.2832);
    ctx.fill();
    ctx.restore();
    // DEPTH — extruded side wall (darker) down-right of the top face + drop shadow.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.5 * lvl})`;
    ctx.shadowBlur = 3 + lift * 0.8;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2 + lift * 0.5;
    const wall = [Math.round(col.g2[0] * 0.5), Math.round(col.g2[1] * 0.5), Math.round(col.g2[2] * 0.5)];
    ctx.fillStyle = `rgb(${wall[0]},${wall[1]},${wall[2]})`;
    roundRect(dx + ext * 0.35, dy + ext, w, GAP, 2);
    ctx.fill();
    ctx.restore();
    // TOP FACE — the surface slice (old before 90°, new after), same color.
    ctx.save();
    roundRect(dx, dy, w, GAP, 2);
    ctx.clip();
    ctx.drawImage(src, ox0 * dpr, oy0 * dpr, GAP * dpr, GAP * dpr, dx, dy, w, GAP);
    ctx.restore();
  };

  const WAVE_SPEED = 0.34,
    FLIPLEN = 255; // px/ms wavefront (unchanged) × wide band → each tile's flip takes ~750ms (slow, varied phases)
  const renderWave = (now: number) => {
    const R = (now - waveState!.t0) * WAVE_SPEED;
    // OLD surface everywhere
    if (pcbReady) ctx.drawImage(pcbOld, 0, 0, pcbOld.width, pcbOld.height, 0, 0, W, H);
    // NEW surface inside the settled circle (behind the flip band)
    const inner = Math.max(0, R - FLIPLEN);
    if (inner > 0 && pcbReady) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(waveState!.ox, waveState!.oy, inner, 0, 6.2832);
      ctx.clip();
      ctx.drawImage(pcb, 0, 0, pcb.width, pcb.height, 0, 0, W, H);
      ctx.restore();
    }
    // the ring of flipping tiles at the wavefront (the wave IS the flip — no
    // drawn accent line)
    for (const tile of tiles) {
      const dist = Math.hypot(tile.cx - waveState!.ox, tile.cy - waveState!.oy);
      const reach = R - dist;
      if (reach > 0 && reach < FLIPLEN) drawFlipTile(tile, reach / FLIPLEN);
    }
    if (R > waveState!.maxR) waveState = null;
  };

  // Deflate-on-release: after the pointer leaves, the dome descends over
  // DEFLATE_MS — every raised tile lowers together (the "ball" deflating)
  // instead of snapping flat the instant the finger lifts.
  const DEFLATE_MS = 420;
  let releaseAt = 0; // performance.now() when the pointer left; 0 = not deflating

  const frame = (now: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (waveState) {
      renderWave(now);
      raf = requestAnimationFrame(frame);
      return;
    }
    // Base: the static printed PCB, seamless (no gaps between tiles at rest).
    if (pcbReady) ctx.drawImage(pcb, 0, 0, pcb.width, pcb.height, 0, 0, W, H);
    // Shimmer: a soft band sweeping LEFT→RIGHT; only the sparse `br` tiles it
    // passes lift, producing a directional shimmer (not random everywhere).
    const SH_SPEED = 0.36,
      SH_BAND = 60,
      SH_AMP = 0.5;
    const shimX = ((now * SH_SPEED) % (W + 2 * SH_BAND)) - SH_BAND;
    // Dome height: 1 while held, ramps to 0 over DEFLATE_MS after release.
    let domeStrength = 0;
    if (cursor.on) domeStrength = 1;
    else if (releaseAt) {
      domeStrength = 1 - (now - releaseAt) / DEFLATE_MS;
      if (domeStrength <= 0) {
        domeStrength = 0;
        releaseAt = 0;
      }
    }
    for (const tile of tiles) {
      let z = 0;
      if (tile.br) {
        const d = Math.abs(tile.cx - shimX);
        if (d < SH_BAND) {
          const k = Math.cos((d / SH_BAND) * (Math.PI / 2));
          z += k * k * SH_AMP * tile.amp;
        }
      }
      if (domeStrength > 0) {
        const dx = tile.cx - cursor.x,
          dy = tile.cy - cursor.y;
        const d2 = dx * dx + dy * dy,
          R = 72;
        if (d2 < R * R) {
          const k = 1 - Math.sqrt(d2) / R;
          z += k * k * domeStrength;
        }
      }
      if (z > 1) z = 1;
      // Flat tiles are already shown by the base PCB — only raise the active ones.
      if (z > 0.02) drawTile(tile, z, 0);
    }
    raf = requestAnimationFrame(frame);
  };

  // Once destroy() runs (the board unmounted) no public method may restart the
  // rAF loop or re-arm deferred work — otherwise a deferred runWave() frame can
  // resurrect a detached ~60fps loop that never stops (one orphaned loop per
  // brand-takeover-then-navigate; they stack and the page gets slower the more
  // you visit). Guarding start()/wave() neutralizes every resurrection path
  // (wave/setCursor/clearCursor/setEmblem all funnel through start()).
  let destroyed = false;
  const waveTimers: number[] = [];

  const start = () => {
    if (destroyed) return;
    if (!running && visible && !reducedMQ.matches) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const drawStatic = () => {
    // reduced-motion: the static printed PCB, once
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (pcbReady) ctx.drawImage(pcb, 0, 0, pcb.width, pcb.height, 0, 0, W, H);
  };

  const ro = new ResizeObserver(() => {
    resize();
    if (reducedMQ.matches) drawStatic();
  });
  ro.observe(board);
  resize();

  const io = new IntersectionObserver(
    (es) => {
      visible = es[0].isIntersecting;
      if (visible && !reducedMQ.matches) start();
      else stop();
    },
    { threshold: 0 },
  );
  io.observe(board);

  const onVis = () => {
    if (document.hidden) stop();
    else if (visible && !reducedMQ.matches) start();
  };
  document.addEventListener('visibilitychange', onVis);
  const onRM = () => {
    if (reducedMQ.matches) {
      stop();
      drawStatic();
    } else start();
  };
  reducedMQ.addEventListener('change', onRM);

  if (reducedMQ.matches) drawStatic();
  else start();

  return {
    setCursor(x: number, y: number) {
      cursor.x = x;
      cursor.y = y;
      cursor.on = true;
      releaseAt = 0;
      start();
    },
    clearCursor() {
      cursor.on = false;
      releaseAt = performance.now();
      // Ensure the loop is running so the deflate ramp pumps to completion
      // (no-op if already running / paused off-screen / reduced-motion).
      start();
    },
    wave(ox: number, oy: number) {
      if (destroyed) return;
      if (reducedMQ.matches) {
        refreshColor();
        buildPCB();
        snapshotCircuit();
        return;
      }
      // Snapshot the CURRENT (old) surface, then rebuild pcb to the NEW colors
      // (the consuming component set the brand vars just before calling this).
      pcbOld.width = pcb.width;
      pcbOld.height = pcb.height;
      pgOld.setTransform(1, 0, 0, 1, 0, 0);
      pgOld.clearRect(0, 0, pcbOld.width, pcbOld.height);
      if (pcbReady) pgOld.drawImage(pcb, 0, 0);
      refreshColor();
      buildPCB();
      const maxR = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) + FLIPLEN + 20;
      waveState = { ox, oy, t0: performance.now(), maxR };
      // re-rasterize the vectors to the new accent once the brand vars settle
      while (waveTimers.length) clearTimeout(waveTimers.pop());
      [120, 600].forEach((d) =>
        waveTimers.push(
          window.setTimeout(() => {
            refreshColor();
            snapshotCircuit();
            buildPCB();
          }, d),
        ),
      );
      start();
    },
    refreshColor,
    setEmblem(img, cx, cy, size) {
      emblem = { img, cx, cy, size };
      buildPCB();
      start();
    },
    clearEmblem() {
      emblem = null;
      buildPCB();
    },
    destroy() {
      destroyed = true;
      while (waveTimers.length) clearTimeout(waveTimers.pop());
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      reducedMQ.removeEventListener('change', onRM);
    },
  };
}

/* Build the inline CSS-var overrides that re-skin a board in brand colors.
   Board greens become shades of the primary; the gold accent system becomes
   the secondary. Values are resolved to CONCRETE rgb() in JS — color-mix()
   serializes to oklab() which the 1×1 readback path needs to parse back, so
   we never hand a color-mix() to the tokens. Plain rgb() is unambiguously
   valid and transitions cleanly. */
const _csCv = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c;
})();
const _csCtx = _csCv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
function _csRGB(color: string): [number, number, number] {
  _csCtx.clearRect(0, 0, 1, 1);
  _csCtx.fillStyle = '#000';
  _csCtx.fillStyle = color;
  _csCtx.fillRect(0, 0, 1, 1);
  const d = _csCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
function _csMix(a: string, b: string, pa: number): string {
  // pa% of a, rest b, mixed in sRGB → "rgb(r,g,b)"
  const ca = _csRGB(a),
    cb = _csRGB(b),
    t = pa / 100;
  return `rgb(${Math.round(ca[0] * t + cb[0] * (1 - t))}, ${Math.round(ca[1] * t + cb[1] * (1 - t))}, ${Math.round(ca[2] * t + cb[2] * (1 - t))})`;
}
export function brandVars(primary: string, secondary: string): Record<string, string> {
  const sec = _csRGB(secondary);
  return {
    '--board-1': _csMix(primary, '#0a0c0e', 30),
    '--board-2': _csMix(primary, '#07090b', 20),
    '--board-3': _csMix(primary, '#0a0c0e', 40),
    '--gold': `rgb(${sec[0]}, ${sec[1]}, ${sec[2]})`,
    '--gold-bright': _csMix(secondary, '#ffffff', 72),
    '--gold-deep': _csMix(secondary, '#000000', 62),
  };
}

export const CsCopy = ({ text }: { text: string }): ReactElement => {
  const [copied, setCopied] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      navigator.clipboard && navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    clearTimeout(t.current);
    t.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      className="csb-copy"
      data-copied={copied ? '1' : '0'}
      onClick={copy}
      aria-label={'Copy ' + text}
      title="Copy"
    >
      <span className="csb-copy-ico" aria-hidden="true">
        {copied ? '✓' : '⧉'}
      </span>
      <span className="csb-copy-txt">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
};

export const csTelHref = (p: string | null | undefined): string =>
  'tel:' + (p || '').replace(/[^0-9+]/g, '');
