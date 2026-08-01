# Admin liquid glass — token foundation

STATIC port of the owner's liquid-glass system (Perry's `admin-restyle-spec.md`
"Materials" recipe + `packages/ui/src/styles/globals.css` tokens) into the
circuits-com admin token layer. The model for this port is the owner's own
static fork, `collab-kit/tokens.css`, and the precedent in this repo is
`mail/roundcube-skin/circuitcenter/DESIGN.md` — both are cited in the ledger
below. Glass here is **static**: pure-CSS hover/active states, no JS gloss or
rim driver, no keyframes, no `will-change`.

**Where things live**

- Tokens: `admin/components/AdminLayout.module.scss` — inside the existing
  `.admin` token block, with dark values in the existing
  `:global(html[data-admin-theme='dark'])` override. Custom properties inherit,
  so everything under the admin root theme-switches for free.
- Utilities: `admin/styles/glass.scss` — a GLOBAL stylesheet (literal class
  names, not CSS-Module hashed), side-effect-imported once by `AdminLayout.tsx`.
- Nothing is applied yet. Later work consumes `.a-glass-pane`, `.a-glass-ctl`,
  `.a-glass-well` and the tokens directly.

## Token table

Filters are theme-independent (only colors flip in dark).

| Token | Role | Light | Dark |
|---|---|---|---|
| `--a-glass` | Pane veil (sheets, popovers, sticky bars) | `linear-gradient(rgba(255,255,255,.88), rgba(255,255,255,.78))` | `linear-gradient(rgba(30,39,56,.90), rgba(21,28,41,.86))` |
| `--a-glass-filter` | Pane backdrop-filter | `saturate(180%) blur(20px)` | (same) |
| `--a-glass-ctl` | Control/button veil | `linear-gradient(rgba(255,255,255,.62), rgba(255,255,255,.30))` | `linear-gradient(rgba(255,255,255,.11), rgba(255,255,255,.05))` |
| `--a-glass-ctl-filter` | Control backdrop-filter | `blur(14px) saturate(170%)` | (same) |
| `--a-glass-rim` | 1px hairline rim | `rgba(17,24,39,.10)` | `rgba(255,255,255,.16)` |
| `--a-glass-hi` | Inset top-highlight (composable shadow) | `inset 0 1px 0 rgba(255,255,255,.75)` | `inset 0 1px 0 rgba(255,255,255,.09)` |
| `--a-glass-shadow` | Contact + ambient pair, resting | `0 1px 2px rgba(0,0,0,.05), 0 8px 24px -12px rgba(0,0,0,.14)` | `0 1px 2px rgba(0,0,0,.45), 0 12px 28px -10px rgba(0,0,0,.55)` |
| `--a-glass-shadow-hover` | Deepened pair for hover rise | `0 2px 4px rgba(0,0,0,.07), 0 14px 28px -10px rgba(0,0,0,.20)` | `0 2px 4px rgba(0,0,0,.50), 0 16px 34px -10px rgba(0,0,0,.65)` |
| `--a-glass-press` | Press-state inset compression | `inset 0 1px 3px rgba(0,0,0,.12)` | `inset 0 1px 3px rgba(0,0,0,.60)` |
| `--a-glass-well` | Recessed-channel fill | `rgba(17,24,39,.06)` | `rgba(0,0,0,.30)` |
| `--a-glass-well-shadow` | Recessed-channel inset | `inset 0 1px 2px rgba(0,0,0,.06)` | `inset 0 1px 2px rgba(0,0,0,.50)` |
| `--a-focus-ring` | Two-ring focus halo | `0 0 0 3px rgba(10,74,46,.18), 0 0 0 1.5px var(--a-primary)` | `0 0 0 3px rgba(31,157,99,.30), 0 0 0 1.5px var(--a-primary)` |

## Utilities (`glass.scss`)

- `.a-glass-pane` — veil + backdrop-filter (both prefixes) + rim + top-highlight
  + contact/ambient pair. No states; panes rest.
- `.a-glass-ctl` — control material with pure-CSS states: hover rises 1px and
  deepens the cast, `:active` compresses to `scale(.97)` + `--a-glass-press`,
  `:focus-visible` swaps to the two-ring halo, `:disabled` fades to .45.
  `prefers-reduced-motion` removes the transition and both transforms.
  Explicit `line-height: 1.2` (the body's 1.6 overflows height-constrained
  controls — a documented house gotcha).
- `.a-glass-well` — recessed/inset channel: dark fill + transparent border +
  inset shadow. For search fields, segmented tracks, kbd.

All utilities use `var(--a-radius)` (8px) — the admin's own single radius.

## Adopted / adapted / skipped (vs the donor system)

**Adopted verbatim**

- `--btn-glass` veil `.62 -> .30` and `--btn-glass-filter: blur(14px)
  saturate(170%)` — the control material, unchanged (light theme).
- `--glass-filter: saturate(180%) blur(20px)` — the pane filter.
- The state grammar: hover rises + deepens the cast; press compresses with an
  inset; focus is a two-ring halo; disabled fades.
- The contact + ambient shadow pattern (tight contact, large negative-spread
  ambient) and the inset top-highlight.
- The binding rule **one filled primary action per screen** (below).
- The static-fork scope decision itself: `collab-kit/tokens.css` dropped the
  JS gloss/rim driver and kept "the always-visible parts of the material and
  pure-CSS states only". This port makes the identical call.

**Adapted (and why)**

- **Pane veil, light.** Donor `--glass` is cream `rgba(250,246,239,.72)` over a
  cream page. This admin's bench is cool gray `#f5f7fa` and its panes hold
  dense 16px `--a-fg3` metadata, so the pane veil is a white gradient raised to
  `.88 -> .78`: fg3 clears 4.5:1 over the bench, and a floating pane over solid
  ink content still holds fg1/fg2 (the mail skin's raised-veil finding,
  re-derived — see the contrast tables).
- **Pane veil, dark.** The mail skin's finding is that a translucent white veil
  over a dark bench composites to mud; it raised the white veil to `.92 -> .88`
  *because its glass keeps dark text*. This admin's dark mode flips `--a-fg*`
  light, so the same principle lands differently: the veil flips to
  near-opaque **smoked glass in the theme's own ink direction**
  (`rgba(30,39,56,.90) -> rgba(21,28,41,.86)`, i.e. hover-tone to card-tone).
  What carries over unchanged is the actual finding: the floor opacity goes UP
  (.86, vs a naive alpha-scaled .30) so the composited result is predictable —
  fg1 stays over 11:1 even when the lightest chart mark (`#f3cf5c`) scrolls
  underneath.
- **Control veil, dark.** A white veil at high opacity would demand dark text
  and break `var(--a-fg1)` inheritance; instead the control is a low-alpha
  white lift (`.11 -> .05`) whose worst case is COMPUTED for light text
  (below). Labels are fg1/fg2 only.
- **Hairline.** Donor hairlines are warm dark-on-cream `rgba(46,42,38,.08)`.
  Light theme re-inks to the admin's cool ink `rgba(17,24,39,.10)`; dark theme
  inverts to a light rim `rgba(255,255,255,.16)` — the mail skin's
  "light lives at the silhouette" inversion, dialed to sit beside the existing
  `--a-border #2a3446`.
- **Focus ring.** Two-ring halo pattern kept; sage swapped for the admin
  primary (which already flips per theme, so only the halo alpha is themed).
- **Radius.** Donor scale is 9/11/12/16/18/999. The admin already owns a single
  8px `--a-radius` used everywhere; utilities use it. Importing the donor scale
  would create strays here, not remove them.
- **Elevation naming.** Donor `--shadow-s/m/l` not imported as-is; the glass
  pair lives in `--a-glass-shadow(-hover)` beside the existing
  `--a-shadow-sm/md` so non-glass admin surfaces keep their current depth.

**Skipped (and why)**

- **Cursor-tracked conic rim + approach gloss** (`--ra`, `--gloss-k`/
  `--gloss-ang`, the SVG rim-light overlay) — coupled to Perry's
  `AdminShellClient` selectors; inert dead CSS without it. Same call as
  `collab-kit/tokens.css` and the mail skin. Out of scope by direction.
- **`mix-blend-mode` / pointer-driven CSS-var gradients** — deleted twice in
  this repo (v11.2 cursor-lamp, v15 `useFlashlight`). Never again.
- **Permanent `will-change`** — pins DPR²-sized GPU layers; documented iPhone
  OOM in this repo. None anywhere in the glass system.
- **`pfPulse` / keyframes** — nothing in this foundation animates; if a later
  consumer needs a keyframe it must live in the same stylesheet/module that
  references it (CSS Modules hash `animation-name`).
- **Cream/sage/red hues, Cormorant, fractional type weights** — Perry's voice.
  The admin keeps its own ink ramp, DM Sans chrome, and existing weights.
- **`hue-rotate` anywhere** — promotes a compositor layer even at 0deg.

## Contrast — computed, not eyeballed

Method (mail-skin precedent): composite the veil's FLOOR alpha over the
worst-case backdrop, ignoring any lightening from blur. That composited color
is identical to the no-`backdrop-filter` fallback, so old browsers inherit
these exact numbers. Script: WCAG 2.x relative luminance; text passes at
4.5:1 (the admin's 16px floor means no "large text" exemptions are assumed).

**Light** (bench `--a-bg #f5f7fa`; ink fg1 `#111827` / fg2 `#4b5563` / fg3 `#6b7280`):

| Surface (worst case) | Composited | fg1 | fg2 | fg3 |
|---|---|---|---|---|
| Pane floor .78 over bench | `#fdfdfe` | 17.47 | 7.44 | **4.76** |
| Control floor .30 over bench | `#f8f9fc` | 16.89 | 7.19 | **4.60** |
| Well fill over card `#ffffff` | `#f1f1f2` | 15.72 | 6.70 | 4.28 FAIL |
| Well fill over bench | `#e7eaed` | 14.67 | 6.25 | 4.00 FAIL |
| FLOATING pane .78 over solid ink `#111827` | `#cbcccf` | 11.06 | **4.71** | 3.01 FAIL |

**Dark** (bench `--a-bg #0e131c`; fg1 `#f1f4f9` / fg2 `#c3ccda` / fg3 `#93a0b4`):

| Surface (worst case) | Composited | fg1 | fg2 | fg3 |
|---|---|---|---|---|
| Pane floor .86 over bench | `#141b27` | 15.69 | 10.69 | **6.53** |
| Pane floor over lightest chart mark `#f3cf5c` | `#343530` | 11.21 | 7.63 | **4.66** |
| Control top .11 over `--a-hover` | `#363e4d` | 9.77 | 6.65 | 4.07 FAIL |
| Control top .11 over pane top | `#353d4b` | 9.92 | 6.75 | 4.13 FAIL |
| Well fill over card | `#10151e` | 16.59 | 11.29 | **6.90** |

Rim visibility (decorative, no 3:1 requirement): light 1.23:1, dark 1.67:1
against their panes — hairlines by intent.

**Binding text rules that fall out of the math:**

1. `--a-fg3` is allowed on **resting glass panes** in both themes, and nowhere
   else on glass: not inside wells, not on controls, not on floating panes.
2. **Floating glass** (anything that passes over arbitrary scrolled content —
   sticky bars, popovers over tables/charts) carries `--a-fg1`/`--a-fg2` only.
3. Control labels are `--a-fg1` (or fg2). Primary-green text
   (`--a-primary`) on a dark glass control is 3.11:1 — it is a fill color,
   never ink on glass.
4. `--a-fg4` never appears on glass except as disabled/decorative.

## House law: ONE filled primary action per screen

From the donor spec, binding here exactly as written there: **one filled
primary action per screen; everything else glass or quiet.** In this admin the
filled primary is the existing `--a-primary` green CTA (e.g. the topbar
"New Part"). When glass restyling reaches a screen, every other button on it
becomes `.a-glass-ctl` or a quiet/text control; a second filled green button
on the same screen is a defect, not a style choice. Destructive stays
text-red until hover tint (`--a-danger`) — danger never shouts.

## Reference example

The only sanctioned usage until component restyling begins. Renders inside any
admin page (tokens inherit from `.admin`); flips correctly with the topbar
theme toggle because every value routes through the token layer:

```tsx
// inside an admin page component — glass.scss is already loaded by AdminLayout
<section className="a-glass-pane" style={{ padding: 16 }}>
  <h3>Glass pane</h3>
  <div className="a-glass-well" style={{ padding: '8px 12px' }}>
    Recessed channel (fg1/fg2 text only)
  </div>
  <button type="button" className="a-glass-ctl" style={{ padding: '10px 16px' }}>
    Glass control
  </button>
</section>
```

Verified 2026-07-31: `npx tsc -b` clean, `npm test` clean,
`npx eslint --ext .ts,.tsx src/` clean, `npm run build` compiles `glass.scss`
into the production bundle.

## Non-negotiables (each traces to a real production bug)

- No `mix-blend-mode` + per-pointermove CSS-var gradients (deleted twice here).
- No permanent `will-change`; no `filter: hue-rotate()` even at 0deg.
- `backdrop-filter` always declared with `-webkit-` twin.
- No perpetual rAF loops; `prefers-reduced-motion` respected (already wired in
  `.a-glass-ctl`).
- Keyframes live in the stylesheet that references them (none exist yet).
- Every new small-text-on-glass pairing gets COMPUTED against the worst-case
  composited background before shipping — extend the tables above, don't
  eyeball. The math lives in the mail skin's method; the veil floor over the
  worst backdrop IS the no-filter fallback.
- Non-ASCII glyphs in JSX get mangled by edit tooling — HTML entities/escapes
  only in consuming components.
