# Circuit Center webmail — design notes

**The inspection bench.** The brief was "cyberpunk-iOS": not neon-on-black —
the collision of Apple's material restraint with a circuit-board world. This
skin resolves that collision literally. The application is a workbench: a
solder-mask green bench, ruled by the site's 24px PCB grid, falling into
shadow. Floating 10px above it are three panes of liquid glass — the folder
list, the message list, the reading pane — built from the owner's own glass
recipe (Perry's admin restyle). The one surface that is *not* glass is the
task rail at the far left: bare board, ENIG contact fingers, the edge you
hold. Glass is where you read; the board edge is where you grab.

The first pass rendered the mail client *as* a dark board and it was
well-made — its selector engineering, its edge-connector signature, its
datasheet typography and its refusal to animate all survive here. What it
lacked was the second half of the brief: there was no glass, no depth, no
material at all — only paint. This revision keeps the board and adds the
optics.

---

## Palette

Six named colours. Every ratio below is computed (WCAG 2.x relative
luminance), and measured against the **worst effective surface** the colour
can sit on — for glass, that is the veil's *floor* alpha composited over the
*darkest* bench, ignoring any lightening from blur. That worst case is
identical to the no-`backdrop-filter` fallback, so old browsers inherit the
audited numbers, not worse ones. Pane worst case: `rgba(255,255,255,.88)`
over `#051d13` = `rgb(225,228,227)`. Selected row: ENIG tint `.26` over that
= `rgb(227,219,189)`.

| Token | Hex | What it is | Where it goes | Contrast (worst / selected) |
|---|---|---|---|---|
| Bench green | `#0e4a2d` | Solder mask in raking light | The environment: substrate gradient (to `#051d13`), task rail, seen through and between the glass | — (backdrop) |
| Silk ink | `#16281f` | Silkscreen ink, dark side | Primary text, unread subjects, button labels | 12.09 / 11.15 |
| ENIG gold | `#e8c252` | Gold plating, lit | Rail labels (10.30 on rail), lit finger, selection tint, focus halo, LED glow — bright gold is *never* body text on glass | 10.30 on rail |
| Legend gold | `#6d5211` | Gold in shadow — plating at text weight | Silkscreen panel titles, fieldset legends, popover headers | 5.73 / 5.28 |
| Phosphor | `#44bd13` | Oscilloscope trace | GLOW ONLY: the active task's trace stub, the fresh-mail ring, the bench grid. As text it is `#1a680f` (links: 5.41 / 4.99, 6.93 on white) | ≥3:1 where structural |
| Flag red | `#a42e22` | Rework marker | Flagged rows, errors, destructive text buttons | 5.48 / 5.06 |

Supporting inks, same math: `--cc-ink-2 #3a4f43` read subjects (6.90 / 6.36),
`--cc-dim #4d5f54` metadata (5.33 / 4.91 — the skin's global minimum),
`--cc-led #96690a` unread LED dot (3.80 / 3.50, non-text ≥3),
`--cc-edge #64756a` field borders (3.36 on the recessed fill),
`--cc-focus #8a6a1c` focus ring (3.95 on glass, 3.49 on the rail — one stroke
that clears 3:1 on both worlds). Alert pairs: info `#1c4e63`/`#ddeef7` 7.61,
success `#1d5c10`/`#e1f3da` 6.96, warning `#6b4e0a`/`#f4e7c3` 6.28, error
`#8f2417`/`#f7ddd8` 6.70. Quote inks on the quote fill: 5.02 / 5.31 / 5.08.
Gold-pad legend `#241a04` on the pad: 7.60 (button), 7.74 (unread count).

**Why these and not any other glass palette.** Every hue is something you can
point to on hardware Circuit Center sells. `#0e4a2d` is the register of the
site's `$executive-blue` (its "PCB dark green" hero). `#e8c252` is the sponsor
boards' `--gold` verbatim — ENIG plating, the finish on every contact finger
in the catalog. Phosphor descends from `$nav-blue #44bd13`, the trace green
the marketing site already runs through its hero circuits. The one cool hue in
the skin is conformal-coating blue on informational alerts — the other colour
that appears on real boards, used once so the four alert states stay
tellable apart. A generic glassmorphism would put this exact glass over a
blue-purple gradient; a generic cyberpunk would put magenta neon on black.
Neither of those belongs to an electronics distributor. A bench does.

## Type

Two families, no downloads — and now the donor system's fractional variable
weights (520 buttons / 560 controls / 590 emphasis / 650 headings, never
bold).

- **UI and prose:** `-apple-system, BlinkMacSystemFont, 'SF Pro Text',
  'Segoe UI', 'Inter', system-ui, sans-serif` — character-for-character the
  site's `$font-body`, and the SF-register sans the glass system was designed
  against.
- **Measured values:** `ui-monospace, 'SF Mono', SFMono-Regular, Menlo,
  Consolas, 'Liberation Mono', monospace` — the site's `$font-mono`, which it
  already uses for SKUs, prices and designators. Sender, date, size, unread
  counts, quota, headers, plain-text bodies — plus `font-variant-numeric:
  tabular-nums` wherever digits column up.

The split is datasheet typography: numbers are visibly numbers. On an
electronics company's tooling this is not a style, it is the house register —
and in a mail list it doubles as a scanning aid that costs no colour.

## Layout concept

Elastic's columns, densities and breakpoints are untouched. What changes is
the *matter* each column is made of:

```
┃█ CN1        ╭─ U1 · FOLDERS ─╮  ╭─ U2 · INBOX ────────────╮  ╭──────────────╮
┃█ ← bare     │ glass pane      │  │ glass pane              │  │ glass pane   │
┃  board      │ folder tree     │  │ ● unread LED · mono meta│  │ porcelain    │
┃█ rail       │ gold unread pads│  │ gold-tint selection     │  │ coupon +     │
┃█            ╰─────────────────╯  ╰─────────────────────────╯  │ white sheet  │
┃█   bench + 24px grid visible in the 10px gaps                 ╰──────────────╯
```

- Panes carry the full glass stack: veil gradient, `saturate(180%) blur(20px)`
  (with `-webkit-` twin), a **light** 1px rim (on a dark bench the glass edge
  catches light — the donor hairline, inverted), inset top-highlight, ambient
  `--shadow-m`. Exactly three static backdrop-filter layers exist at rest.
- Toolbars are a lighter veil *without* their own filter — nothing ever
  scrolls under a Roundcube header, so a second blur layer would buy nothing.
- Search and form fields are the donor's recessed channel, re-hued.
- Menus and dialogs are near-opaque porcelain glass (`.96`) at card/sheet
  radius with `--shadow-m`/`--shadow-l` — the only filters created at runtime,
  and the only surfaces that genuinely float over live content.
- The reading pane steps back: message header on a raised porcelain coupon,
  1.6 line-height, and **HTML mail keeps its white sheet — mounted** (rounded,
  hairlined, shadowed) rather than recoloured. Kept from the first pass; on a
  light skin it is also simply native.
- ≤768px the glass is furled: panes go edge-to-edge, opaque `#f2f5f3`, and
  every `backdrop-filter` is dropped — phone GPUs pay for blur in
  DPR²-sized layers, and this repo has OOM-crashed iPhones with cheaper
  effects. All ratios only improve on the opaque surface.

## The signature element: the edge connector — the one unglazed surface

Kept from the first pass, and sharpened by the new material system. The task
rail is the card edge of a board that is plugged in: a full-height column of
ENIG contact fingers on bare bench, the active task's finger lit gold with a
short **phosphor** trace bleeding toward the glass. In the first pass it was
one dark strip among dark panels. Now it is the only thing in the app that
isn't glass — the composition reads as *board held at the edge, instruments
floating above it*, which is exactly what a bench tech sees all day.

Why it suits this company and no other cyberpunk project: contact fingers are
the single most recognisable feature of a circuit board — the part of the
product Circuit Center's customers literally plug in. It is peripheral by
construction (a 6px strip at the screen edge, present for eight working hours
without competing with a message), it is load-bearing (the lit finger IS the
which-task-am-I-in indicator), and it costs one repeating-gradient and one
box-shadow. Below 481px the rail becomes a popover and the fingers are scoped
out.

Supporting grammar, quiet on purpose: silkscreen **component designators** —
U1 on the folder pane, U2 on the list, U3 in the empty reading pane, CN1 on
the login card (the connector you plug into). They are empty-content
pseudo-elements with inline-SVG backgrounds, so screen readers never hear
them; the site already prints U1/U2 on its contact page, so the four people
who use this client will get the joke in the first second. The login screen
is the one full view of the bench: a single glass sheet with plated
through-holes at its corners, the bench visible down the drills.

## The liquid-glass system: adopted / adapted / skipped

The owner's system (Perry's `admin-restyle-spec.md`, `globals.css` tokens,
and the `collab-kit` static fork) was treated as the recipe, not a mood board.

**Adopted verbatim**
- `--btn-glass: linear-gradient(rgba(255,255,255,.62), rgba(255,255,255,.30))`
  and `--btn-glass-filter: blur(14px) saturate(170%)` — the control material.
- `--glass-filter: saturate(180%) blur(20px)` — the pane material's filter.
- The `.pf-glass` shadow stack: omnipresent bright inner rim, inset top
  highlight, inset bottom shade, contact + ambient cast — and its state
  grammar: hover rises 1px and deepens the cast, press compresses to
  `scale(.97)` with an inset shadow.
- The elevation trio `--shadow-s/m/l`, both easings
  (`cubic-bezier(.2,.8,.2,1)` / `(.34,1.56,.64,1)`), the fractional weights
  (520/560/590/650), the radius scale (9/11/12/16/18/999 — no strays), the
  recessed-channel recipe, and the binding rule **one filled primary action
  per screen** (here: Send/Save, the ENIG pad; delete is a text-red ghost
  that never shouts).

**Adapted (and why)**
- **The pane veil.** Donor `--glass` is `rgba(250,246,239,.72)` — a cream
  toolbar tint designed to sit over a cream page. Over a near-black green
  bench, a `.72` veil composites to a mid-tone mud on which 13px metadata
  cannot reach 4.5:1. Panes that hold dense small text instead carry a
  `.92 → .88` white veil — measured to hold every ratio at the veil floor —
  while the verbatim `.62 → .30` veil is reserved for controls, which sit on
  the already-light panes. This is the brief's own hierarchy: when glass
  costs legibility, legibility wins.
- **The hairline.** Donor hairlines are dark-on-cream (`rgba(46,42,38,.08)`).
  A dark hairline on a dark bench is invisible; pane edges instead carry a
  *light* rim (`rgba(255,255,255,.55)`) — the same "light lives at the
  silhouette" idea, inverted for a dark backdrop. Dark hairlines survive
  *inside* the glass (row separators, toolbar underlines), re-hued to ink-green.
- **The focus ring.** Two-ring halo pattern kept, sage swapped for gold:
  `0 0 0 3px rgba(232,194,82,.38)` + a `#8a6a1c` stroke on fields; a plain
  2px `#8a6a1c` outline elsewhere (it must also read on the dark rail, where
  a box-shadow halo would vanish).
- **The lit primary.** Donor is brand-red with white text. Circuit Center's
  primary is an ENIG pad — top-lit gold gradient with a *dark* legend
  (`#241a04`, 7.60:1), because white-on-gold is a ~2.4:1 failure and because
  dark silkscreen on gold plating is how a real pad is labelled. Same
  material grammar (top highlight, bottom shade, accent-tinted ambient),
  different metallurgy.
- **Alert chips.** Donor chip idiom (tint-on-soft-tint, sentence case) applied
  to Roundcube's four alert states, hues from the hardware world.

**Skipped (and why)**
- **The cursor-tracked conic rim and the approach gloss** (`--ra`,
  `--gloss-k`/`--gloss-ang`, the SVG rim-light overlay). They are driven by
  Perry's `AdminShellClient` pointer script, which is coupled to that admin
  shell's selectors — ported here they would be permanently inert dead CSS.
  The owner's own static fork (`collab-kit/tokens.css`) made the identical
  call and documents it; this skin follows that precedent. Roundcube gets the
  always-visible parts of the material and pure-CSS states only.
- **`pfPulse` and every keyframe.** The donor pulses live status dots. This
  skin ships **zero** `@keyframes` — a webmail tab stays open for eight
  hours, and this repo's history with long-lived animation loops is the
  reason the budget is zero. "New mail" is carried by a static phosphor ring
  instead.
- **Cormorant/serif brand moments and the cream/sage/red hues.** They are
  Perry's voice, not Circuit Center's. Nothing serif; nothing cream.
- **A dark mode.** The skin *is* dark outside the glass and light inside it;
  one audited contrast set (`dark_mode_support: false`, and Elastic's
  dark.less is never engaged).

## What this skin refuses to do

Inherited from the first pass, still binding, now with the glass-specific
clauses added:

- **No perpetual animation.** Zero `@keyframes`, `animation`,
  `requestAnimationFrame`, `<canvas>`. Motion is hover/focus transitions on
  transform, box-shadow and colour only; `prefers-reduced-motion` neutralises
  even those.
- **No `will-change`, ever** — permanent `will-change` pins DPR²-sized GPU
  layers (documented iPhone OOM in this repo). No `mix-blend-mode`, no
  `hue-rotate` (compositor promotion even at 0deg), no pointer-driven CSS
  variables — the two patterns this repo deleted twice.
- **`backdrop-filter` is static, prefixed both ways, and absent ≤768px.**
  Three resting layers on desktop; menus add theirs only while open; the
  full-viewport dialog scrim is deliberately blur-free.
- **No glow on body text.** Glow appears on the unread LED (a dot) and the
  lit finger (a strip). Neon on running text is why most cyberpunk UI is
  unreadable.
- **No external assets.** No CDN, webfont, remote image or `@import`; the
  only `url()`s are inline SVG data-URIs (their `xmlns` is a namespace
  identifier, not a fetch).
- **No layout changes inside the panes.** Elastic's densities, row heights
  and breakpoints are load-bearing for a tool used eight hours a day. The
  10px bench gaps and pane radii live *outside* the working surfaces.

## Verification status

Computed, not eyeballed: every pair above was produced by compositing math
(worst-case veil floor over darkest bench). Global minimum: **4.91:1**
(metadata on a selected row); every non-text indicator ≥ **3.36:1**.

Rendered audit against the live install (mail.circuitcenter.ai, Roundcube
1.6.x, 2026-07-31): the login screen was verified at 1440px and phone width
— bench, glass card, drill-holes, CN1, gold pad all correct (the IC
wordmark renders correctly too, but activating it needs the one-line
`skin_logo` config in README Install step 3 — the stock cube's src is baked
in Elastic's own login template and resolves elastic-first, a mechanism
confirmed from the release-1.6 source after a first, wrong, file-shadowing
attempt); on
phone the card goes opaque and computed `backdrop-filter` is `none`
everywhere, as designed. The audit caught two real bugs, both fixed: the
bench gradient TILED at 24px (a background-size list one layer short — the
grid var expands to two layers) and the login route's `#layout-content`
carrying the pane veil across the whole viewport (now carved out;
`body.task-login` shows the open bench, and the card is the only glass).
The served compiled Elastic sheet was also pulled and every `!important`
declaration touching our properties extracted — seven verified mirrors now
live in section 11 (datepicker and jQuery-UI actives, TinyMCE focus ring,
grouped-input focus, image-tools hover, the rail popover header, rail
separators). Still pending (needs a logged-in session): message list,
reading pane, compose, and the iframe-opacity check — the README's "Verify
after install" section lists them.
