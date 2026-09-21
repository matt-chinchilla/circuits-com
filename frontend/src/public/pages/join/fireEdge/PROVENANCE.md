# `fire-edge.vendor.js` — provenance

**Byte-identical** to the owner's design export. Do not edit it; re-export instead.

- Source: the owner's Claude Design project `3bbc46a2-917c-4348-a7e1-3bb008cd9e2c`,
  file `ui_kits/website/fire-edge.js`, imported 2026-09-21 as
  `.superpowers/sdd/2026-09-21-join-founders-discount/design-import/fire-edge.js`.
- sha256 `d80d76e684e0ad81f9dc9c7e93e567d1914962f70e6567da4037346276e17fbb`
  (22,357 bytes). Verify with:
  `cmp .superpowers/sdd/2026-09-21-join-founders-discount/design-import/fire-edge.js \
       frontend/src/public/pages/join/fireEdge/fire-edge.vendor.js`
- **No patches.** Unlike `glow-badge.vendor.js` there was nothing to patch: the
  file loads no assets (every sprite is drawn into an offscreen `<canvas>` at
  runtime) and never reads `document.currentScript`, so it bundles as-is. Only
  the `.js` name changed; the bytes did not, which is what makes the `cmp` above
  — and the sha in `fireEdge.test.ts` — the whole integrity check. A provenance
  header inside the file would break both.
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
