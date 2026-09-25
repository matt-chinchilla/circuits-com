# About page — "Why Circuit Center?" rewrite + Founder's Deal block (2026-09-25)

Owner brief (verbatim points, 2026-09-25): the section that asks "Why Circuit Center?" and
says "For over two decades …" must be replaced. It has to harp on:

1. Circuit Center is a NEW company, born out of noticing complacency in the incumbent
   part-data aggregators that have gone uncontested for decades.
2. We give small businesses that want to grow a MEANS to do so (our pricing, and the novelty
   of our tools).
3. We are a personable company; the ONLY way we grow is through our customers' success; a
   dedication to QUALITY and the CUSTOMER EXPERIENCE unparalleled across nearly every
   industry.
4. Customer feedback is welcome AND rewarded financially when useful, plus custom-tailored
   benefits (a company page designed for the supplier/manufacturer on our site, or help with
   their data pipelines) free of charge.
5. A recent EXPLOSION in popularity beyond expectations; the Founder's discount, shown WITH
   the badge animations, eligible for a LIMITED TIME; founders are appreciated "like they
   couldn't believe"; join now before it is too late.
6. New updates daily; reach out at the contact page.

Also: "spruce up" the About page so it WOWs a prospect a sales rep sends there; shaders /
fun animations welcome (owner rule 2026-09-23: Figma-sourced, shaders only where organic).

Not in scope: How It Works (except its "Connect" body, which loses its dash: `Click through to the distributor of your choice in a new tab. We never gate the buy link, so your relationship stays with them.`), the stats strip (live `/api/stats` figures), the header
band, any deploy (owner playtests localhost first — phase-gated builds rule).

## Design (Fable, 2026-09-25)

Subject: a challenger directory for electronic components, selling boards to distributors and
manufacturers. Audience of this page: a prospective supplier, usually sent here by a rep.
Job: make them feel the company is new, hungry, personable, quality-obsessed, generous with
feedback, and that the Founder window is closing.

One bold element: the **Founder's Deal block** — the join page's Founder material (black
dotted slab, brand-red palette) with BOTH Founder badges at hero scale and a burning lip.
Everything else is quiet and disciplined.

Ambient (not the bold element): the whole "Why" section sits on the steel graphite ground
with a slow **caustic light field** behind it — a port of Figma's first-party "Water
caustic" shader fill (account library id `9cd7048d-3c21-4074-b883-e14725fdf05b`, version
`ceda6b136951e8a367863c9fa89ea40545e8e50d`) rendered in the brand green over graphite. It
reads as light moving under a solder mask / signal in copper: organic to the subject, and the
Figma-sourced motion the owner asked for.

### Tokens

Colours (all existing tokens; no new hex in components):
- Section ground `var(--theme-nav-bg)` (#0e1113 steel). Text on it: `#fff` for the display
  line, `rgba(244,245,247,.78)` body, `rgba(244,245,247,.55)` quiet.
- Accent `var(--theme-accent)` (#44bd13) — the rail, pad rings, caustic highlight.
- Founder palette = the join page's `.tier.fd` custom properties, restated locally on the
  block: `--tc: #e8695c; --tc-bright: #ffb59f; --tc-deep: #c0392b;` slab `#101314` with the
  same `radial-gradient(circle, rgba(255,255,255,.13) 1px, transparent 1px)` dot texture,
  `border-top-color: var(--tc)`.
- Light sections unchanged (`--theme-surface-bg`, `--fg1`, `--fg2`).

Type: the system stack (project constraint). Scale on the dark section: display line
`clamp(1.9rem, 3.6vw, 2.9rem)` / 700 / `letter-spacing: -0.022em` / `line-height: 1.08`,
max 22ch, `text-wrap: balance`; manifesto `1.08rem` / 1.6 / max 64ch; rail claim `1.25rem` /
700 / `#fff`; rail body `1rem` / 1.6 / max 58ch; Founder headline `clamp(1.5rem, 2.6vw,
2.1rem)` / 700; the ONE mono designator tag on the block (`Fd · Founder's Deal`, the header
band's REV-A style). No other uppercase labels, no numbered markers (the commitments are not
a sequence), no arrows appended to new buttons.

### Layout (section order on the page is unchanged: band → How → Stats → Why → CTA)

```
┌ .aboutWhy — full-bleed graphite, <CausticField/> absolutely behind, 1px top rule ──────┐
│  Why Circuit Center?                                   (h2, quiet, 0.95rem, accent)     │
│  The places engineers look for parts stopped           (display line, white)            │
│  competing years ago. We didn't.                                                        │
│  [manifesto, 64ch]                                                                      │
│                                                                                         │
│  ○─  A way up for the businesses still growing    body…                                 │
│  │                                                                                      │
│  ○─  We only grow when you do                     body…      ← .whyRail: grid           │
│  │                                                             [28px pad | 1fr | 1.6fr] │
│  ○─  Useful feedback gets paid                    body…        rail = 1px accent line   │
│  │                                                             through the pad column,  │
│  ○─  Something new ships every day                body…        a 10px ring per row      │
│                                                                                         │
│  ┌ .founderBlock (join Founder material) ─────────────────────────────────────────────┐ │
│  │ Fd · Founder's Deal                                   [glow-badge] [fire-badge]    │ │
│  │ Founders are appreciated like they can't believe.                                  │ │
│  │ body (two short paragraphs)                                                        │ │
│  │ [Claim the Founder's Deal]  [Talk to us]                                           │ │
│  └───────────── <fire-edge lip> burning along the bottom rim ─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Left-aligned throughout (the current section is centered; the new one is not — a manifesto
reads as a voice, not a poster). Max content width 1100px like the band. ≤768px: the rail
grid becomes `[28px | 1fr]` with the body under the claim; the Founder block stacks badges
above the headline and the two buttons go full-width.

### Copy (verbatim — the implementer types exactly this; curly quotes as HTML entities)

**Register rule (owner, 2026-09-25 15:40): no em dashes or en dashes anywhere in the page's
visible copy, How It Works included; every sentence reads like spoken, grammatical language,
never like an agent's reply.** The stats strip's `—` placeholder is a glyph, not a statement.

Section heading (h2): `Why Circuit Center?`

Display line: `The places engineers look for parts stopped competing years ago. We didn’t.`

Manifesto:
`Circuit Center is new. It started in 2026, after two decades of the same few part-data
aggregators going uncontested and growing comfortable. We don’t sell parts. We make them
findable, and we build the tools the incumbents never bothered to.`

Rail rows (claim → body):

1. `A way up for the businesses still growing` →
   `Our pricing is set for a distributor’s first marketing dollar, not its hundredth. The
   BOM tool, the in-browser Design Viewer and the live comparison table exist so a small
   supplier can be as findable as the largest.`
2. `We only grow when you do` →
   `There is no other path. Circuit Center is a small, personable company, and every bit of
   our growth is downstream of our customers’ growth. That is why we hold ourselves to a
   standard for quality and customer experience that almost no industry bothers to reach.`
3. `Useful feedback gets paid` →
   `Tell us what would make the directory work harder for you. When it is useful, we pay for
   it, in money and in benefits tailored to your company, like a company page designed for
   you on Circuit Center or an engineer’s time on your data pipeline, at no charge.`
4. `Something new ships every day` →
   `The site changes daily. If you want something it does not do yet, tell us on the
   [contact page] and a person will answer.` (`contact page` is a `<Link to="/contact">`.)

Founder block:
- tag: `Fd · Founder’s Deal` (mono, the band's `.tag` treatment in the Founder red)
- headline (h3): `Founders are appreciated like they can’t believe.`
- body 1: `Interest in Circuit Center has outrun every expectation we set for it, so the
  Founder’s Deal is open for a limited time only. Join while it is and you keep the
  Founder’s Badge beside your name, first access to everything that ships after, and the
  price you joined at, for as long as you stay.`
- body 2 (prices, from the single home below): `Silver is $210 a month, Gold is $2,100 and
  Platinum is $8,500. That number never goes up.`
- buttons: `Claim the Founder’s Deal` → `/join?founder=1` (primary, Founder red);
  `Talk to us` → `/contact` (ghost on dark).
- badges: `<glow-badge size={64} scheme={scheme} glow={2} speed={3}>` and `<fire-badge
  badge="true" size={64} scheme={scheme} intensity={1.6} opacity={1} sparks="true">`, the
  pair wrapped `role="img" aria-label="Founder’s Badge, pulsing and burning variants"`;
  `scheme` steps through `BADGE_SCHEMES` every 3s while the block is on screen (the join
  page's exact rhythm). The block's `overflow: visible` — the fire canvas reaches 2.4× the
  pin above it.
- lip: the join page's `Fire` helper (`pages/join/FounderDiscount.tsx` exports it) —
  `<Fire on={ignited} mode="lip" delay="0" dur="2" scale="16" sustain="0.35" />` anchored
  in a 2px `.founderFire` span at the bottom, exactly as `.fdFire` does. `ignited` flips
  true ONCE when the block first enters the viewport (IntersectionObserver, threshold 0.35;
  no IO → set it 800ms after mount) and never flips back. Under
  `prefers-reduced-motion: reduce` it stays false (no fire-edge at all); the two badges
  already paint one static frame under reduced motion.

Bottom CTA section (replaces "Ready to Get Listed?"):
- h2: `Reach a person, not a queue.`
- sub: `Something new ships every day. Tell us what the directory should do next, or ask a
  rep to walk you through a board.`
- buttons: `Talk to us` → `/contact` (`.glowBtnGold`, unchanged style); `Browse parts` →
  `/search` (`.glowBtnGhost`).

Delete: `ABOUT_WHY`, `.aboutWhyLead`, `.aboutWhyGrid`, `.aboutWhyCard`, `.aboutWhyIcon`, the
`whyRef`/`whySeen` fade (the new section has NO entrance animation — the one orchestrated
moment on this page is the Founder block's ignition).

### Founder prices — ONE home

Create `frontend/src/public/pages/join/founderDeal.ts`:

```ts
/** The Founder's Deal, as the site displays it. Charged by the server's
 *  sales_pricing.FOUNDER_USD; api/tests/test_sales_pricing.py pins these
 *  three strings to it (test_founder_literals_match_the_join_page). */
export const FOUNDER_DEAL_USD = {
  silver: '$210',
  gold: '$2,100',
  platinum: '$8,500',
} as const;
```

`pages/join/index.tsx` `JOIN_TIERS` reads `fd: FOUNDER_DEAL_USD.gold` / `.platinum` (Silver
stays `null` — its charged price is probed). The About block reads all three. Rewrite the
Python test to read `founderDeal.ts` with `re.search(r"silver:\s*'\$([\d,]+)'", src)` etc.
and pin ALL THREE to `sp.FOUNDER_USD`.

### `/join?founder=1`

`readJoinParams` (`pages/join/exclusive.ts`) gains `founder?: true` when `q.get('founder')
=== '1'`; `JoinParams` gains the field; the page's `fdOpen` `useState` initialises from
`params.founder === true`; the strip effect's key list adds `"founder"`. Test in
`exclusive.test.ts` (`readJoinParams('?founder=1')` → `{ founder: true }`, and `?founder=2`
→ `{}`).

### `<CausticField />` — `frontend/src/public/pages/about/CausticField.tsx`

Contract (the page imports this; the shader agent implements it):

```tsx
interface CausticFieldProps {
  className?: string;
  /** Test seam: how the component asks the canvas for a context. Default
   *  `canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })`. */
  getContext?: (canvas: HTMLCanvasElement) => WebGLRenderingContext | null;
}
export default function CausticField(props: CausticFieldProps): ReactElement
```

Renders `<div class="field {className}" aria-hidden="true" data-caustic="webgl"|"static">`
with a `<canvas>` child ONLY on the webgl path. `data-caustic="static"` when the context is
null, on `webglcontextlost`, or when shader compile/link fails — the SCSS paints a static
fallback (two soft accent radial gradients at 10–14% over the ground) so the section never
looks empty.

Rendering: WebGL1 fullscreen triangle; fragment = the Figma "Water caustic" math ported
1:1 to GLSL ES 1.00 (`MAX_ITER 5`, `inten = mix(0.002519, 0.01178, intensity)` with
`intensity = 0.35`, `scale 1.6`, `c = 1.17 - pow(c, 1.4)`, `mask = clamp(pow(abs(c), 8.0),
0, 1)`), with the Figma `playhead` replaced by `t = u_time * 0.10 + 23.0` (seconds). Output
opaque: `mix(u_base, u_accent, mask * 0.30)`; `u_base`/`u_accent` are read ONCE at mount
from `getComputedStyle(document.documentElement)` (`--theme-nav-bg`, `--theme-accent`, hex
→ 0–1; fall back to #0e1113 / #44bd13 when unparsable). Canvas backing size = CSS size ×
min(devicePixelRatio, 1) × 0.5 (a 1180×640 section is ~590×320 fragments), resized on a
ResizeObserver (present in browsers; absent → size once). `u_res` = backing size.

Loop: ONE `requestAnimationFrame` per tick, capped at 30 fps (skip a frame when
`now - last < 33`), started only while the field is intersecting (IntersectionObserver,
threshold 0) AND the document is visible (`visibilitychange`), never after unmount (a
`destroyed` flag like csFx). `prefers-reduced-motion: reduce` → draw exactly ONE frame at
t = 23 and never start the loop. Cleanup: cancel rAF, disconnect observers, remove
listeners, `WEBGL_lose_context.loseContext()` if available. No `will-change`, no CSS
`filter`, no `mix-blend-mode` (site perf rules).

Tests (`causticField.test.ts`, happy-dom, createRoot + act, no testing library):
1. `getContext` returning null → `data-caustic="static"`, no `<canvas>`, rAF never called.
2. A minimal fake GL (an object recording `drawArrays` calls, returning truthy from
   `createShader`/`createProgram`/`getShaderParameter`/`getProgramParameter`, stub the rest
   as no-ops) with reduced motion stubbed ON → exactly one `drawArrays` and rAF never
   called.
3. Same fake, reduced motion OFF, IO absent (`globalThis.IntersectionObserver` undefined
   → treat as visible) → the loop starts (rAF called ≥ 1), and unmount cancels it
   (`cancelAnimationFrame` called, `loseContext` called when the extension exists).
4. Source witness: the fragment source contains `pow(abs(c), 8.0)` and `1.17 - pow(c, 1.4)`
   (the port is the Figma math, not an approximation).

### Page tests (`aboutPage.test.ts`, happy-dom)

- Renders the four rail claims in order, the display line, and no "two decades" / "go-to
  resource" anywhere in the document text.
- The Founder block renders one `glow-badge` and one `fire-badge`, both `size="64"`, the
  three `FOUNDER_DEAL_USD` strings, a link to `/join?founder=1` and a link to `/contact`.
- `fire-edge` is NOT rendered active before the block is seen; with a stubbed IO that fires
  intersecting → `active="true"`; with reduced motion stubbed on → still `"false"`.
- SCSS witnesses (read `AboutPage.module.scss` from disk): `.aboutWhy` has `position:
  relative` + `overflow: hidden`; `.founderBlock` has `overflow: visible`; hover tints on
  the rail rows/buttons live inside `@media (hover: hover)`; the static fallback paints
  under `[data-caustic='static']`.
- Vendor custom elements read `matchMedia`/`ResizeObserver` at import — stub them in
  `vi.hoisted` exactly as `founderBadge.test.ts` does.

### Guards to respect (from CLAUDE.md)

TS strict (no unused vars, no `_` prefixes); `?:` never catches `null`; no non-ASCII glyph
literals in JSX text (entities); empty SCSS rule = undefined class; vitest `css` is false
so CSS-module assertions prove nothing — read the SCSS; `@media (hover: hover)` for hover
tints; never `will-change`/`filter`/`drop-shadow` animation; `Link` for internal routes;
the page's `<motion.div>` wrapper and `PageHeaderBand` stay as they are; `.aboutBody`
keeps the surface background; buttons inherit `line-height: 1.6` (set `line-height: 1`);
public → public imports only (`pages/join/FounderDiscount`'s `Fire` and
`pages/join/founderDeal` are public); the two vendor `.js` side-effect imports need their
`.d.ts` siblings (already present).

---

## Revision 2 (owner, 2026-09-25 19:22): the caustic field is replaced by the signal band

The owner found the green caustic over graphite "foreboding". Four fields were prototyped
(a keep-out pour, a datasheet page, tier metals, a logic analyzer) and a combined "capture";
the owner chose the **logic analyzer, refined** ("seems good! implement it"). The prototype is
`scratchpad/about-ambient-options.html` (artifact https://claude.ai/artifact/AZrZ6Pw18KpqDLht1yss7i, v5).

### What changes on the page

- `.aboutWhy` ground becomes **navy `#0f1721`** (a local custom property `--why-bg` on the
  section, not a theme token; the whole section, Founder block included, sits on it). The
  `<CausticField />` and its files (`CausticField.tsx`, `CausticField.module.scss`,
  `caustic.ts`, `causticField.test.ts`) are DELETED, with every reference and the page test's
  caustic witnesses.
- A full-width **`<SignalBand />`** sits BETWEEN the manifesto and the rail: the section's
  markup becomes `inner(head: h2, display, manifesto)` → `SignalBand` → `inner(rail, Founder
  block)`, so the band spans the section's full width while the text keeps the 1100px column.
  Vertical rhythm: `margin: 2.4vw 0 2.6vw` clamped to 24–40px each side; height
  `clamp(150px, 19vw, 200px)`.
- Everything else (copy, rail, Founder block, CTA, tests for those) is unchanged.

### `<SignalBand />` — `frontend/src/public/pages/about/SignalBand.tsx`

Contract:

```tsx
export interface SignalBandProps { className?: string }
export default function SignalBand(props: SignalBandProps): ReactElement
```

Renders `<div class="band {className}" aria-hidden="true" data-signal="live"|"still">` with ONE
`<canvas>` child (created by React is fine here: no GPU context is held). The canvas is
transparent (`clearRect` each frame); the section's navy shows through.

Pure module `frontend/src/public/pages/about/signalBand.ts` (DOM-free, unit-tested):
- `NAVY = '15,23,33'` — the rgb of `#0f1721`; a test reads `AboutPage.module.scss` and pins
  `--why-bg: #0f1721` to it.
- `BIT = 34` px per bit · `SPEED = 14` px/s roll · `CYCLE = 200` bits · `ACQUIRE_S = 1.6`.
- `uart(text)` → bits: per char, start `0`, eight data bits LSB first, stop `1`
  (`uart('A')` is `[0,1,0,0,0,0,0,1,0,1]`).
- `LANES` (order is display order): `CLK` green, level `k & 1`; `CS` green, `bar: true`
  (active-low bar drawn over the name), level always `0`; `TX` cyan, an 8N1 frame of
  `UPDATE` starting at bit 6, idle `1` elsewhere; `RX` cyan, a frame of `FEEDBACK` starting
  at bit 90; `SDA` cyan, `hash(k * 31 + 977) & 1` with the prototype's integer hash. Levels
  are periodic in `CYCLE` (`mod(k) = ((k % CYCLE) + CYCLE) % CYCLE`).
- Colours: green `68,189,19` (the site accent), cyan `95,196,214`; stroke
  `rgba(<rgb>,.34)`, width 1.2, `lineJoin: 'miter'`; labels `600 10.5px` mono at x = 18,
  `rgba(255,255,255,.4)`; the waves start at `x0 = 66`; lane amplitude `gap * 0.30` where
  `gap = height / LANES.length`; the last 22% of the width fades to the ground with a
  linear gradient of `rgba(NAVY, 0 → 1)`.
- `paint(ctx, { width, height, dpr, scroll, acq })` draws one frame (labels, clipped waves up
  to `x0 + (width - x0) * acq`, the fade, and a 1.5px cyan sweep line at the reveal edge
  while `0 < acq < 1`) — so a happy-dom test with a recording fake 2D context can assert
  what a frame contains without a real canvas.

Component behaviour (`SignalBand.tsx`):
- `ResizeObserver` on the host sizes the canvas (`dpr` capped at 2). One `requestAnimationFrame`
  per tick, 30 fps cap; runs only while intersecting (IntersectionObserver, threshold 0) AND
  `!document.hidden`; a `destroyed` flag (csFx law) closes every entry point after unmount.
- Acquisition: `acq` runs 0 → 1 over `ACQUIRE_S` from the FIRST tick after the band is on
  screen (not from mount), then `scroll += dt * SPEED` with `dt` clamped to 100 ms.
- `prefers-reduced-motion: reduce` → `data-signal="still"`, one `paint` with `acq = 1`,
  `scroll = 0`, never a loop. Otherwise `data-signal="live"`.
- No `will-change`, no CSS `filter`.

Tests (`signalBand.test.ts`, node): uart, lane levels (CLK alternates, CS is 0, TX bits 6..65
equal `uart('UPDATE')`, idle high outside), NAVY ↔ SCSS pin. (`SignalBand.test.ts`,
happy-dom, createRoot + act): reduced motion → `data-signal="still"`, exactly one paint, rAF
never called; motion → `data-signal="live"`, rAF called, unmount cancels; the fake 2D context
records `strokeStyle`/`fillText` so the five lane names are asserted in a frame.

### Docs

CLAUDE.md gets ONE bullet under Gotchas (About page: the band, the navy ground, the no-dash
register rule, the Founder price home `founderDeal.ts`, `?founder=1`). The spec's §"Design"
stays as history; this revision is the current truth.
