# CategorySponsorBanner v11 — Traces-First Redesign

**Date:** 2026-05-31
**Status:** Design approved, pending implementation plan (writing-plans is next)
**Predecessor:** v10 (color-coded per-net traces; ~20 components across two asymmetric strips)
**File scope:** `frontend/src/public/pages/category/components/CategorySponsorBanner.{tsx,module.scss}` only

## Motivation

The v10 banner moved in the wrong direction:

- **7 distinct net colors** (one per chip + VCC/GND/signal-bus) made the banner read as a stylized schematic explosion, not a real PCB photo.
- **~20 components packed across two thin strips** left no breathing room. Several traces ended in dead space ("open leads").
- **Proportions inverted for an ad banner:** chip-text occupied ~30% of vertical space, PCB chrome ~70%. For sponsorship advertising, the chip text should be the centerpiece.
- The whole composition violated a basic PCB-photo convention: real boards use **one trace color on a colored substrate**, with nets distinguished by routing — not hue.

User direction (verbatim summary):

> Aggressive reset. Plan traces FIRST, components later. Some chips interconnected (it's "1 board"), but not every pin. Some leads go to test-point vias, some leads sit parallel to a future diode/cap as anchor stubs. Logical and symmetric layout. ICs can flex on size, but not too far from reality. Keep at 6 pins per side.

## Goal

Lock the **trace topology only** in v11. Every pin terminates at one of: a power/signal bus, a labeled test-point via, or a component-anchor stub that ends in a via dot. **Zero open leads.** All current components are deleted. Components return in v12-v16 passes, each adding 3-8 carefully placed SMT-scale parts on the anchors reserved here.

## Non-Goals (out of scope for v11)

- Component placement (deferred to v12+; see "Component plan" section below)
- Mobile layout changes (≤1080px breakpoint keeps current grid stacking, SVG strips remain `display: none`)
- Theme variants (silver/platinum tier color overrides preserved as-is)
- `.id` sponsor brand column (left side of banner) — unchanged
- Click-to-energize machinery: preserve activeNets / triggerNet / 4500ms keyframe, but rewire click targets from deleted components onto the new bus segments / via clusters
- Categorical pricing data, supplier directories, or any other site feature

## Architecture

### Banner geometry — 220px locked, re-proportioned

```
220px = 6 (top pad)
      + 43 (top SVG strip — VCC bus + drop-taps + signal buses)
      + 11 (top chip pin row, overlaps bottom 11 of top SVG)
      + 100 (chip body — the ad content)
      + 11 (bottom chip pin row, overlaps top 11 of bot SVG)
      + 43 (bot SVG strip — GND bus + drop-taps + signal buses)
      + 6  (bottom pad)
```

CSS coordinates within `.rail` (height 208 = 220 - 12 rim):

| Element | Top y | Height | viewBox |
|---|---|---|---|
| `.boardArt` (top SVG) | 0 | 43 | `0 0 1100 43` |
| `.chipPinsTop` (pin row) | 43 | 11 | (HTML, no viewBox) |
| `.field` (chip body) | 54 | 100 | (HTML) |
| `.chipPinsBottom` (pin row) | 154 | 11 | (HTML) |
| `.boardArtBottom` (bot SVG) | 165 | 43 | `0 0 1100 43` |

**Changes from v10:**
- `.boardArt height: 65 → 43`
- `.field top: 65 → 54`, `height: 55 → 100`
- `.boardArtBottom top: 120 → 165`, `height: 88 → 43`

### Coordinate-locking — preserved unchanged from v10

The HTML chip's CSS x-coordinate must match the SVG viewBox-fractional x-coordinate. This is the just-fixed mechanism that makes traces visibly land on pin tabs at any rail width. **Do not modify.**

| Variable | Value | Source |
|---|---|---|
| `CHIP_X` | `{ p1: 137, p2: 412, p3: 687, p4: 962 }` | TSX constant |
| `CHIP_BODY_VU` | `240` | TSX constant |
| `VIEWBOX_W` | `1100` | TSX constant |
| `.field { left: var(--cx-pct); width: var(--cw-pct); transform: translateX(-50%) }` | `--cx-pct = CHIP_X[i]/11%`, `--cw-pct = 21.818%` | SCSS + inline TSX style |
| `.chipPin { left: (dx + 120) / 240 * 100% }` | per-pin inline style | TSX `ChipPinRow` |

### Pin function table — symmetric across all 4 chips

Every chip uses the SAME dx→function mapping. Visually, the 4 chips become identical wiring patterns — only `.pLabel` and `.val` text differs.

`TOP_STUB_DX = BOT_STUB_DX = [-50, -30, -10, 10, 30, 50]` (unchanged from v10).

| dx | Top row function | Bottom row function |
|---|---|---|
| **-50** | VCC drop-tap → VCC bus (top edge, y≈8) | GND drop-tap → GND bus (bot edge, y≈35) |
| **-30** | Test-point via — short stub up, ends in labeled via dot at y≈14 | Cap-anchor stub — stub down to via at y≈29 (decoupling cap pad in v12) |
| **-10** | SDA bus — horizontal trace at y≈22, taps all 4 chips' inner-left pin | DOUT-A bus — horizontal at y≈21, taps all 4 chips' inner-left pin |
| **+10** | SCL bus — horizontal at y≈28, taps all 4 chips' inner-right pin | DOUT-B bus — horizontal at y≈27, taps all 4 chips' inner-right pin |
| **+30** | Diode-anchor stub — stub up to via at y≈14 (LED/diode pad in v13) | Resistor-anchor stub — stub down to via at y≈29 (R or cap pad in v14) |
| **+50** | IO test-point via — short stub up to via at y≈8 (top edge) | IO test-point via — short stub down to via at y≈35 (bot edge) |

y coordinates are approximate within the 43vu strip; final values locked during implementation.

### Inter-chip connectivity

Four horizontal buses unify all 4 chips into "one board":

- **Top SVG (2 buses):**
  - **SDA** at y≈22 — single horizontal trace spanning x≈87..1012 (chip P1's dx=-10 pin to chip P4's dx=-10 pin)
  - **SCL** at y≈28 — single horizontal trace spanning x≈147..972 (chip P1's dx=+10 pin to chip P4's dx=+10 pin)
- **Bot SVG (2 buses):**
  - **DOUT-A** at y≈21 — mirrors SDA position
  - **DOUT-B** at y≈27 — mirrors SCL position

Each bus is one horizontal line. From each bus, 4 short vertical drops connect to the corresponding pin on each chip. Plus two single-bus terminator vias at each bus's left and right endpoints (small via dots so the bus visibly "ends" rather than running off-screen).

### Termination contract — zero open leads

Every trace endpoint resolves to one of three terminations:

1. **Bus tap** — short vertical drop from chip pin to one of the 6 buses (VCC, GND, SDA, SCL, DOUT-A, DOUT-B). Tap point marked with a small via dot at the bus-to-stub junction.
2. **Test-point via** — labeled gold circle with darker drill hole, sized 6vu diameter (matches scale-anchor "0.5mm via").
3. **Component-anchor stub** — short stub ending at a via dot reserved for a future SMT component pad. v12+ component bodies will straddle these via positions.

No trace ends in the middle of empty substrate.

### Color palette — monochrome with brightness-only hierarchy

All net colors deleted. Single gold tone, three brightness levels for trace function:

| Class | Stroke | Use |
|---|---|---|
| `.busVcc`, `.busGnd` | `color-mix(in srgb, var(--gold) 75%, transparent)` | Power rails — slightly brighter so they read as primary |
| `.traces`, `.busSignal` | `color-mix(in srgb, var(--gold) 55%, transparent)` | Signal traces, inter-chip buses, drop-taps |
| `.tracesFaint` | `color-mix(in srgb, var(--gold) 28%, transparent)` | Decorative stubs to vias / test points |
| `.pads` | `color-mix(in srgb, var(--gold) 72%, transparent)` | Vias (same as v10) |

**Delete:**
- CSS custom properties on `.board`: `--net-vcc`, `--net-gnd`, `--net-bus`, `--net-p1`, `--net-p2`, `--net-p3`, `--net-p4`
- All `[data-net="pN"] { .traces|.spark|.pads { ... } }` override rules
- `filter: drop-shadow(...)` on `.busVcc` (added in v10 for "hot" power-rail effect — drop)

**Preserve:**
- All other `--gold*` / `--cream*` / `--board*` / `--illum` / `--plasma` variables (used by chip body, energize animation, etc.)
- `[data-tier='silver']` and `[data-tier='platinum']` overrides on `.board`

### Component teardown — delete in v11

All v9/v10 SVG components removed from `BoardArt` and `BottomBoardArt` JSX:

- **Top strip:** J1, F1, L1, C1, Y1 (crystal), C2a, C2b, C3, U2 (op-amp), R3, D1, J3, C4a, C4b
- **Bot strip:** C5, C6, C7, R4, J2, Q1

Their associated trace paths, pads, refdes labels, and `.spark` overlays go with them. The 4 `<g data-net="pN">` wrappers REMAIN (used for click-to-energize) but their inner content is replaced by the new trace-only topology.

### Click-to-energize — preserve, rewire

The `activeNets`/`triggerNet`/`NET_ENERGIZE_MS=4500` machinery stays exactly as-is. Each chip retains its `<g data-net="pN">` wrapper containing **only that chip's private drop-tap traces** (the 6 vertical stubs from pin row to buses/vias on the top side + 6 on the bottom side). Shared horizontal buses (VCC, GND, SDA, SCL, DOUT-A, DOUT-B) sit OUTSIDE all `<g data-net>` wrappers — they're always-lit infrastructure, no per-net animation.

Click target for each net: the chip's private drop-tap group (a roomy clickable surface formed by the 12 short vertical stubs). Clicking activates that net's `data-illuminated='true'` flash on the corresponding `.field` for 4500ms.

The 4500ms keyframe on `.field[data-illuminated='true']` is unchanged.

## Component plan — deferred to v12+

v11 establishes anchor positions. Future passes attach components on those anchors at SMT scale (12 vu/mm reference; see verification section).

| Pass | Components added | Where they attach |
|---|---|---|
| v12 | 4× 0603 decoupling caps (top, one per VCC drop-tap) + 4× 0603 caps on bot GND drop-taps | dx=-50 on top + dx=-50 on bot |
| v13 | 8× 0603 LED + resistor pairs as indicators | dx=+50 IO test points (4 top + 4 bot) |
| v14 | 4× series resistors on the four buses (SDA / SCL / DOUT-A / DOUT-B) | bus midpoints between chips |
| v15 | 1× 3225 SMT ceramic resonator (3-pin) | centered between P2 and P3, top strip |
| v16 | 1× SOT-89 voltage regulator + bulk SMT cap | leftmost slot of top strip (left of P1) |

Each pass adds ≤8 components and preserves breathing room. Components larger than 43vu in any axis (through-hole DIPs, HC-49 crystals, big inductors) are explicitly excluded — substitute with SMT equivalents only.

## Verification

### Trace fit (geometric)

After implementation:
- Count `<path d="..."/>` elements per strip — should be ~30-40 (4 buses + 24 drop-taps + 24 stubs + 8 IO routes). Was ~54+45 in v10.
- Count `<text>` elements — should be 0 (silkscreen labels hidden via `.refdes* { display: none }`). Was 11+5.
- Count via dots (`.pads <circle>`) — should be ~50-70 (one at every trace termination + bus endpoint).

### Coordinate-locking preserved

Run the same measurement script from prior verification rounds:
- Chip drift from `CHIP_X[i]/1100*rail_width` — must stay sub-pixel.
- Each pin tab center — must equal `(CHIP_X[i] + dx)/1100*rail_width` within 0.5px.

### Visual checks (chrome-devtools-mcp)

- Desktop 1440×900: every pin tab visibly connects to a bus, via, or stub-with-via. No floating leads.
- Mobile 390×844: SVG strips hidden (existing breakpoint); chips stack vertically.
- Click P1 → chip P1 illuminates with the 4500ms gold-flash keyframe.
- Single trace color reads cleanly against the dark green substrate.

### Scale anchor (for v12+ planning)

At 1100vu viewBox width ≈ 25mm real-world IC eval board ≈ **12 vu/mm**.

| Component class | viewBox size | Fits 43vu strip |
|---|---|---|
| 0603 SMT cap/R | 18 × 9vu | ✓ |
| 0805 SMT cap/R | 24 × 15vu | ✓ |
| SOT-23 transistor | 36 × 18vu | ✓ |
| SOD-323 diode | 20 × 15vu | ✓ |
| 0603 LED | 18 × 9vu | ✓ |
| 3225 SMT resonator | 38 × 30vu | ✓ |
| SOT-89 regulator | 54 × 30vu | ✓ |
| HC-49 crystal | 132 × 48vu | ✗ skip |
| Through-hole DIP | 80+ × 80+vu | ✗ skip |

## Risks & open questions

- **Banner aspect at narrow rails.** Desktop rail width ranges ~940-1100px depending on viewport. Chip CSS width = 21.818% of rail. At 940px rail → 205px chip × 100px CSS = 2.05:1 aspect (close to DIP-14). At 1100px → 240px × 100 = 2.4:1. Both within "DIP-like" range. No action.
- **`.id` column visual balance.** With chips growing 55→100 and PCB strips shrinking, the .id sponsor column on the left is unchanged (240-340px width). May feel proportionally short next to the taller chip row. Defer evaluation until v11 ships.
- **Empty stubs may read as "unfinished".** The +30/+−30 anchor stubs terminate in via dots with no component yet. Real PCBs with empty pads are uncommon. If this reads weird in screenshots, options: (a) hide the anchor stubs in v11 and add them only in v12 when the component lands, or (b) draw a small "DNP" (do-not-populate) silkscreen ring around the via. Decide after seeing v11.
- **Mobile layout.** Mobile fallback (≤1080px) drops SVGs entirely and grid-stacks chips. With chips now 100px tall, the stacked 4-chip column becomes ~440px tall + paddings/pins ≈ 500px tall block. Acceptable for portrait phones.

## Approval & next step

Design approved by user in chat ("go"). After spec self-review, this spec is presented for explicit user review of the written form. On user approval, invoke the `writing-plans` skill to produce an implementation plan covering: SCSS edits, TSX edits, click-handler rewiring, verification steps, and rollback notes. No code is written until the implementation plan is also approved.
