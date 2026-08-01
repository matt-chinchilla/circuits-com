# Circuit Center webmail — design notes

A cyberpunk skin for a components distributor is an easy brief to get wrong.
The default move is near-black plus neon magenta and cyan, which belongs to no
particular company and fails contrast the moment anyone reads a long thread in
it. This skin takes the opposite route: it is built out of the subject matter.

A printed circuit board is *already* the aesthetic. Dark green solder mask,
gold-plated pads, white silkscreen legends, copper traces, component
designators, a card edge that plugs into a machine. Every one of those is
neo-futuristic on sight and every one of them is literally what Circuit Center
sells. So the skin does not decorate a mail client with circuitry — it renders
the mail client *as a board*.

---

## Palette

Six named colours. Ratios are measured against the surface each one actually
sits on; the second number is the worst case, a selected row.

| Token | Hex | What it is | Where it goes | Contrast |
|---|---|---|---|---|
| `--cc-mask` | `#06180f` | Solder mask, unpopulated | App substrate, task rail, form cavities | — |
| `--cc-board` | `#0b2419` | Board surface | Sidebar, message list, reading pane | — |
| `--cc-silk` | `#e6efe8` | Silkscreen ink | Primary text, unread subjects | 13.96 / 9.56 |
| `--cc-enig` | `#e8c252` | ENIG gold plating | Panel legends, unread pip, focus, primary button | 9.58 / 6.56 |
| `--cc-trace` | `#5fd93a` | Copper trace, energised | Links, success, quota gauge | 8.96 / 6.14 |
| `--cc-dim` | `#93b3a5` | Faded silkscreen | Sender, date, size, hints | 7.21 / **4.94** |

Supporting shades (`--cc-board-hi` `#123626` raised copper pour,
`--cc-select` `#14432c` selected row, `--cc-flag` `#ff8378` flagged,
`--cc-edge` `#3e7a5c` control borders at 3.24:1, above the 3:1 the WCAG
non-text rule asks for) are derived from the same six.

**Why these and not any other dark palette.** `#0b2419` / `#123626` are the
sponsor boards' own `--board-1` / `--board-2` from
`frontend/src/public/pages/category/components/categorySponsor.scss`.
`#e8c252` is that file's `--gold` verbatim. `#5fd93a` is the site's
`$nav-blue: #44bd13` lifted just far enough to clear 4.5:1 on the board —
the same hue the marketing site uses for traces and links. Someone who leaves
circuitcenter.ai and opens the webmail should recognise it as the same company
before reading a word.

The one cool hue in the whole skin is `#7fc4e8` on informational alerts. That
is conformal-coating blue, the other colour that appears on real hardware. It
is used once, deliberately, so the four alert states stay distinguishable.

Every ratio above was computed, not eyeballed, and then re-verified in a
browser against Roundcube 1.6.11's real compiled stylesheet: 67 text nodes
rendered, **minimum ratio 4.94:1, zero failures**.

## Type

Two families, no downloads.

- **UI and body:** `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI',
  'Inter', system-ui, sans-serif` — character-for-character the site's
  `$font-body`. It also quietly removes two font requests: Elastic self-hosts
  Roboto, and nothing here asks for it any more.
- **Data:** `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas,
  'Liberation Mono', monospace` — the site's `$font-mono`, which it already
  uses for SKUs, prices and designators.

The split is the point. Anything that is a *measured value* is set in mono:
sender address, timestamp, message size, unread counts, quota, message
headers, plain-text bodies. Anything that is *prose* stays in the sans. That is
datasheet typography — a document where the numbers are visibly numbers — and
it doubles as a scanning aid, because the eye can separate metadata from
subject without any colour cue at all.

Panel legends (`FOLDERS`, `INBOX`) are 0.7rem mono, uppercase, `0.16em`
tracking, in gold. That is silkscreen — the small white legends printed next to
components — and it is lifted directly from `.csb-badge-txt` on the sponsor
boards.

## Layout concept

Elastic's four columns are kept exactly as they are. Not one row height,
padding or breakpoint changes; this is a tool people work in for hours and its
density is the reason it works. What changes is what each column *is*:

- **Task rail** — the card edge (see below).
- **Folder list** — the net list. Unread counts are gold pads.
- **Message list** — the bill of materials. Mono metadata, one lit indicator
  LED per unread row.
- **Reading pane** — the datasheet page.

The reading pane is where the theme deliberately gets out of the way. The
message header becomes a raised board coupon, plain-text bodies get mono at
1.6 line-height, and **HTML mail keeps Elastic's white sheet**. Forcing
sender-styled HTML into a dark palette is exactly how dark webmail clients
wreck newsletters and signatures. Instead the white sheet is *mounted* — rounded,
gold-hairlined, with a drop shadow — so it reads as a datasheet page sitting on
the board rather than a hole punched through the theme. Same reasoning leaves
the compose editor light: WYSIWYG should show what the recipient will see.

## The signature element: the edge connector

**The task rail is the card edge of a board that is plugged in.** A column of
ENIG-gold contact fingers runs its full height, and the active task's finger is
lit at full brightness with a short trace bleeding into the panel beside it.

Why this one:

- It is the single most recognisable feature of a circuit board. Nobody needs
  it explained.
- It is *peripheral by construction*. It lives in a 6px strip at the very edge
  of the screen, so it is there every second of the working day and never once
  competes with a message. A signature element in a mail client has to survive
  eight hours; anything in the reading path would not.
- It is load-bearing, not decoration. The lit finger **is** the "which task am
  I in" indicator, so the most thematic thing on screen is also doing the most
  ordinary UI job.
- It costs one `repeating-linear-gradient` and one `box-shadow`. No image, no
  canvas, no script, nothing that animates.

Below 481px the rail becomes a popover and the fingers are scoped out — a card
edge on a phone would be decoration without a job.

The supporting grammar: a 24px PCB grid on the substrate (the contact page's
motif), plated drill-holes at the login card's corners (`.csb-fid`), and a bare
board coupon in the empty reading pane.

## What this skin refuses to do

- **No perpetual animation.** Zero `@keyframes`, zero `animation`, zero
  `requestAnimationFrame`, zero `<canvas>`. Motion is hover and focus
  transitions only, and `prefers-reduced-motion` neutralises even those. This
  repo has a documented history of orphaned rAF loops slowing the site the
  longer it is used; a webmail tab stays open far longer than any page on the
  marketing site, so the budget here is zero.
- **No glow on body text.** Glow is used once, on the unread LED, where it is a
  6px shadow on a 4px dot. Neon on running text is the reason most cyberpunk
  interfaces are unreadable.
- **No external assets.** No CDN, no webfont, no remote image, no `@import`.
  The mail host serves everything or it does not exist.
- **No layout changes.** Every density, height and breakpoint decision stays
  Elastic's. Aesthetics were not allowed to buy a single pixel of row height.
