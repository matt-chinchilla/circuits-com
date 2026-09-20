# `glow-badge.vendor.js` — provenance

The owner's second founder artwork, the **Pulsing Badge** (`founder_badge_2`,
released 2026-09-20). One line differs from the design export; everything
else is byte-identical. Do not edit it; re-export and re-apply the patch.

- Source: the owner's Claude Design project "Burning Badge"
  (`https://claude.ai/design/p/8beb0fe1-a0e1-4d23-acaa-bb0c10e5ed0b`, file
  `Pulsing Badge.dc.html` → `glow-badge.js`), imported 2026-09-20 16:00 EDT as
  `.superpowers/sdd/2026-09-17-supplier-founder/design-import/glow-badge.js`
  (sha256 `e4789c30b0450a8e7e17218c0d892367c7ef57a9e5de1ba3dd89fd04263c1c1f`,
  12,633 bytes).
- Vendored file sha256
  `8aa125965889dca832beea2228a207933e5c3d333132dee598a9443e50c2ef5a`
  (12,613 bytes). `founderBadge.test.ts` pins it.
- **The one patch (line 6).** Upstream resolves its dot-grid texture with
  `document.currentScript`, which is `null` for a bundled ES module, so the
  fallback `location.href` would look for `dot-grid.png` beside whatever page
  URL the badge happened to render on (`/category/x/dot-grid.png` → the SPA
  shell). The vendored line is
  `new URL('./dot-grid.png', import.meta.url).href`, which Vite resolves to
  the hashed asset at build time. Nothing else changed:
  `diff design-import/glow-badge.js glow-badge.vendor.js` shows exactly that
  line.
- `dot-grid.png` (96×83 RGBA, sha256
  `899f9dbdaf9b334b7be09140b724cc056b0b8e9b77890895709676ef3c0a15c4`) is the
  design's texture with its C2PA provenance chunk (`caBX`) dropped: the
  pixels are the manifest's own `c2pa.hash.data` — that sha256 IS the hash the
  manifest records for the image minus the manifest — so the picture is
  provably the export's.
- Attributes: `scheme` (the same nine as the fire), `glow` 0–2 (default 1),
  `speed` seconds per cycle (default 2.6), `size` px, `paused`. The site maps
  a holding's `intensity` column onto `glow` (the ranges nest: 0.3–2 ⊂ 0–2,
  same default) and stores `speed` in its own column (migration 056).
- Self-registering (`customElements.get('glow-badge')` guard), shadow DOM,
  CSS keyframes only (no canvas, no rAF loop). The halo reaches 85% of the
  pin's size beyond it on every side, so the same `overflow: visible` rules
  the fire needed on the boards cover it.
