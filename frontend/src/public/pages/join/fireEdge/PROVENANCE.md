# `fire-edge.vendor.js` — provenance

The owner's design export plus TWO documented patches (below). Do not edit it beyond those; re-export and re-apply instead.

- Source: the owner's Claude Design project `3bbc46a2-917c-4348-a7e1-3bb008cd9e2c`,
  file `ui_kits/website/fire-edge.js`, imported 2026-09-21 as
  `.superpowers/sdd/2026-09-21-join-founders-discount/design-import/fire-edge.js`.
- Upstream export sha256 `d80d76e684e0ad81f9dc9c7e93e567d1914962f70e6567da4037346276e17fbb` (22,357 bytes).
  Vendored file sha256 `eee25869d6d574e2a235f2c435de97264c287a520947c09a987ee42b5653b6e5` (22,161 bytes) —
  the difference is the two patches below. Verify with
  `diff .superpowers/sdd/2026-09-21-join-founders-discount/design-import/fire-edge.js \
        frontend/src/public/pages/join/fireEdge/fire-edge.vendor.js` → three hunks: the
  `_start()` gate line (patch 1), the `_drawCoals` vertex line (patch 2) and the
  coal-layer block in `_step()` (patch 2). Every patched line carries a
  `/* PATCHED … See PROVENANCE.md */` marker. (After patch 1 alone the file was
  `36e43f65a547b8484a846bce7968da8aaa17b23f7a0044f96671e9b37db600cf`, 22,442 bytes.)
- **First patch (2026-09-21, owner: the embers must burn on phones too).** Upstream's
  `_start()` refused to run at `(max-width: 768px)` as well as under
  `prefers-reduced-motion: reduce`; the vendored line keeps ONLY the reduced-motion
  gate: `if (reduced.matches) return; /* PATCHED … */`. Measured before patching
  (emulated 390×844 phone, band open): 14 canvases at 1× backing store, largest
  408×62 px, JS heap flat at 5 MB over 11 s, 60 fps — the mobile gate was a
  precaution, not a budget. The Join page's static fallback slash is now shown
  only under reduced motion (`.stack[data-fire='off']`, decided at ignition), so
  the canvas strike and the CSS strike can never both appear.
- **Second patch (2026-09-24, owner: the new prices and the coal bed "still are
  causing lag" while they draw) — performance only, same pixels.** Two changes,
  both inside the coal bed that each price strike (`<fire-edge mode="line"
  coals>`) redraws every tick for as long as the band is open:
  1. `_step()` drew the ~30–50 coals into a SECOND, offscreen canvas and then
     blitted that onto the element's canvas. The element's canvas has just been
     cleared to transparent at that point and the blit was a plain
     `source-over` at alpha 1, so drawing the coals straight onto it is the
     same operation on the same state. The indirection (a leftover of a
     "throttled layer" experiment — it sat inside an `if (true)`) cost one
     extra canvas clear, one forced flush of that canvas and one full-size blit
     per strike per tick.
  2. `_drawCoals()` built each coal's outline with `c.verts.map(...)` — a new
     array plus one array per vertex (~7 allocations) per coal per frame. It
     now fills one reused buffer per vertex count; the arithmetic is the same
     expression, so the same coordinates reach `moveTo`/`lineTo`.

  Why a vendor patch: nothing outside the file can reach these — the coal
  layer and the vertex arrays are private to `_step()`/`_drawCoals()`, and the
  page only sets attributes. Measured (chrome-devtools, production build,
  1440×900 at 4× CPU, Founder's Discount ignition): a coal strike's `_step()`
  3.43 → 1.62 ms per tick; the shared fire loop 14.6 → 7.4 ms per tick; sampled
  JS allocation over 5 s of a burning bed (1× CPU) 38.2 → 29.3 MB (the per-vertex
  arrays alone were ~6 MB); the longest GC pause in the traces fell from a
  42 ms major GC landing inside the strike (~1 s after ignition) to ≤ 14 ms.
  Parity was proven, not assumed: old and new files rendered side by side with a seeded
  `Math.random` and a hand-driven clock produce byte-identical canvases
  (`getImageData`, 294 snapshots over the price strike at three widths, the
  lip, both sweeps and an additive red coal line; a 2% `coalGlow` change is
  caught by the same harness).
- Nothing else is patched: the file loads no assets (every sprite is drawn into
  an offscreen `<canvas>` at runtime) and never reads `document.currentScript`.
  The sha in `fireEdge.test.ts` pins the PATCHED bytes; a provenance header
  inside the file would break it.
- It lives under `@public/pages/join/` rather than `@shared/` because the Join
  page is its only consumer; the ≥2-consumer rule is what would move it.
- Self-registering (`if (customElements.get('fire-edge')) return;` at the top),
  so it is safe to side-effect-import from more than one module. Its types — and
  the JSX shape of `<fire-edge>` — live in `fire-edge.vendor.d.ts` beside it;
  `allowJs` is off, so that declaration is what lets `tsc -b` see the import at
  all.
- Its only `innerHTML` write is a constant string the file authors itself (the
  shadow stylesheet plus one `<canvas>`). No input of ours reaches it.

## Attribute contract (from the file's own header comment)

Ported from `fire-badge.js` — same sprites, LUT, flicker/wind model and shared
rAF loop. The element fills its positioned parent (`position:absolute; inset:0`)
and paints on a padded canvas.

| Attribute | Meaning | Default |
| --- | --- | --- |
| `active` | `"true"` starts a burn, `"false"` clears it (re-flip to replay) | off |
| `mode` | `lip` — fire rides the host's bottom edge across its full width (panel reveal) · `line` — a burn head travels `x1,y1 → x2,y2` (% of host box), fire + smoke trailing it · `sweep` — a vertical front sweeps left → right (text ignite) | `sweep` |
| `delay` / `duration` | seconds | `0` / `1.2` |
| `scale` | flame size in px (≈ the text height) | `12` |
| `intensity` | 0.3–2 | `1` |
| `opacity` | 0–1 | `0.85` |
| `blend` | `add` = `'lighter'`, for dark grounds · `over` for light grounds | `add` |
| `scheme` | `orange` \| `red` | `orange` |
| `pad` | canvas overscan px | `30` |
| `x1` `y1` `x2` `y2` | `line` endpoints, % of the host box | `0` `100` `100` `0` |
| `coals` | `"true"` lays a glowing coal bed under the front | off |
| `sustain` | 0–1, the level the flame settles to once the front has crossed (0 = goes out) | `0` |
| `hold` | `line`: seconds the flame trail lags the head | `1` |
| `linger` | `line`: seconds the whole drawn line burns on after the head lands | `0` |
| `linear` | `"true"` moves the front linearly instead of on the slash's own `cubic-bezier(.35,.5,.35,1)` draw curve | off |

Two further knobs, `coalGlow` and `coalDensity`, are read off
`document.documentElement.dataset` rather than the element, so they are not
attributes and the `.d.ts` does not declare them.

**It refuses to start under `prefers-reduced-motion: reduce` and at viewports
≤768px** — both gates are built into the file (`matchMedia` at module scope),
matching the Join page's own CSS gates. The page must still ship its static
fallbacks for those cases; the element simply paints nothing.
