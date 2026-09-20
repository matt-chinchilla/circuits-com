# `glow-badge.vendor.js` — provenance

The owner's second founder artwork, the **Pulsing Badge** (`founder_badge_2`,
released 2026-09-20). FOUR lines differ from the design export (listed below);
everything else is byte-identical. Do not edit it; re-export and re-apply the
patches.

- Source: the owner's Claude Design project "Burning Badge"
  (`https://claude.ai/design/p/8beb0fe1-a0e1-4d23-acaa-bb0c10e5ed0b`, file
  `Pulsing Badge.dc.html` → `glow-badge.js`), imported 2026-09-20 16:00 EDT as
  `.superpowers/sdd/2026-09-17-supplier-founder/design-import/glow-badge.js`
  (sha256 `e4789c30b0450a8e7e17218c0d892367c7ef57a9e5de1ba3dd89fd04263c1c1f`,
  12,633 bytes).
- Vendored file sha256
  `e94a5783972d53d94a4e973c96aa91d28126c8becba2f52f0f7ebcf9a2bacdf8`
  (12,642 bytes). `founderBadge.test.ts` pins it.
- **Owner-asked tuning (2026-09-20 17:00, "have the glow extend out 1/2 the
  distance… the pulses happening in-sync").** Two halo insets halved in the
  shadow stylesheet: `#h` `inset:-85%` → `-42.5%`, `#h2` `inset:-25%` →
  `-12.5%`. And the per-instance random animation phase
  (`-(Math.random() * speed)`) replaced by `'0s'`, so every pin on a page runs
  the same cycle in lockstep (they all share one `speed` — one holding per
  supplier — so they never drift apart).
- **The asset-URL patch (line 6).** Upstream resolves its dot-grid texture with
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
