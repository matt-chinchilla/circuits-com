# `fire-badge.vendor.js` — provenance

**Byte-identical** to the owner's design export. Do not edit it; re-export instead.

- Source: the owner's Claude Design project "Burning Badge"
  (`https://claude.ai/design/p/8beb0fe1-a0e1-4d23-acaa-bb0c10e5ed0b`, file
  `Burning Badge.dc.html`), imported 2026-09-17 22:55 EDT, re-exported 2026-09-18 10:10 EDT (white + black accent highlights) as
  `.superpowers/sdd/2026-09-17-supplier-founder/design-import/fire-badge.js`.
- sha256 `59aa499f4390aa9de516180df1d4556499e18d3d2829370245357bb67f8b6e67`
  (14,145 bytes, 167 lines). Verify with:
  `cmp .superpowers/sdd/2026-09-17-supplier-founder/design-import/fire-badge.js \
       frontend/src/shared/components/FounderBadge/fireBadge/fire-badge.vendor.js`
- Only the `.js` extension and the name changed; the bytes did not, so the file
  carries no header comment of ours. That is deliberate — a provenance line
  inside it would break the `cmp` above, which is the whole integrity check.
- The design preview's own defaults are the ones the site ships: `scheme`
  orange, `intensity` 1, `opacity` 0.75, `sparks` true. `FounderBadge.tsx`
  therefore sets NONE of them when it is given no `look`, and lets the element
  default, so a future re-export that re-tunes a default lands on an
  unconfigured board without a code change. A supplier that HAS saved a look
  (migration 055, `supplier_badges`) overrides all four — those values come off
  the payload, and the server, not this file, is what defaults them.
- It is a self-registering custom element (`customElements.get('fire-badge')`
  guard at the top), so it is safe to side-effect-import from more than one
  module. Its types — and the JSX shape of `<fire-badge>` — live in
  `fire-badge.vendor.d.ts` beside it; `allowJs` is off, so that declaration is
  what lets `tsc -b` see the import at all.
- Its `innerHTML` write is a constant string the file authors itself (the shadow
  stylesheet and the pin SVG). No input of ours reaches it.
