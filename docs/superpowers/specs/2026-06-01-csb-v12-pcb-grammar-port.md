# CategorySponsorBanner v12 — PCB-Grammar Port

**Date:** 2026-06-01
**Scope:** Rewrite `BoardArt` + `BottomBoardArt` SVG strips in `frontend/src/public/pages/category/components/CategorySponsorBanner.tsx` to read as a real PCB ad rather than a wireframe schematic. Import the CircuitTraces grammar vocabulary (tokens, S(o,w) helper, footprint catalog) and add real-PCB advertisement signatures (silkscreen designators, decoupling caps, asymmetric per-chip routing, 45° elbows, weight hierarchy).
**Status:** Spec — implementation pending. v11 (commit c69b439) is the immediate predecessor.
**Predecessor spec:** `2026-05-31-csb-v11-traces-first-design.md`

---

## 0. Motivation

v11 shipped a "trace-first" banner: 4 identical DIP chips, 6 identical drop-taps per chip, 2 mirror strips, monochrome gold with brightness-only hierarchy. Phase-1 research surfaces three concrete defects:

1. **Visual weight collapse** — measured stroke widths (1.4–2.2 CSS px) against 100 CSS px chip bodies recede; SDA/SCL buses 6vu apart merge into a single band; 28% faint vs 55% solid is one perceptual band, not two.
2. **Symmetry tell** — 4 identical chips × 2 mirror strips × identical drop-tap fans = 8 visually-identical fans. Real PCBs vary per-chip because each chip taps different bus lanes and sits at a different distance from power-entry.
3. **No PCB-ad vocabulary** — no silkscreen designators, no SMT component bodies inside the strips, no diagonal trace jogs, no edge connectors, no fiducial/legend block. Reads as schematic line-art, not a board photo.

v12 fixes all three while preserving the v11 win (HTML chips + SVG strip coordinate-locked rail) and the click-to-energize behavior.

---

## 1. ROUTING TOPOLOGY

### 1.1 Top strip — viewBox `0 0 1100 43`, `preserveAspectRatio="none"`

**Shared horizontal buses** (rendered OUTSIDE any `<g data-net>` wrapper — always lit infrastructure):

| Bus    | y  | x range      | Class       | Width | Description                                    |
|--------|----|--------------|-------------|-------|------------------------------------------------|
| VCC    |  6 | 5 → 1095     | `.busVcc`   | 3.0   | Top power rail, spans entire strip             |
| SDA    | 18 | 127 → 952    | `.busSignal`| 2.2   | I²C data, taps P1+P2+P3 only (P4 doesn't tap)  |
| SCL    | 32 | 147 → 972    | `.busSignal`| 2.2   | I²C clock, taps P2+P3+P4 only (P1 doesn't tap) |

**Bus separation:** SDA y=18 ↔ SCL y=32 = 14vu gap (vs 6vu in v11) — eliminates the "merged band" defect.

### 1.2 Bottom strip — viewBox `0 0 1100 43`, `preserveAspectRatio="none"`

**Bottom strip is NO LONGER a mirror.** It hosts a power-supply / clock-distribution section.

| Bus       | y  | x range      | Class       | Width | Description                              |
|-----------|----|--------------|-------------|-------|------------------------------------------|
| GND       | 37 | 5 → 1095     | `.busGnd`   | 3.0   | Bottom ground rail, spans entire strip   |
| OSC       | 18 | 380 → 720    | `.busSignal`| 2.2   | Crystal clock distribution P2 → P3       |
| PWR_IN    | 28 | 940 → 1095   | `.busPower` | 3.5   | Regulator output rail toward CN2 (right) |

### 1.3 Per-chip drop routing (Y-lane table, ASYMMETRIC)

Each chip exposes 6 pins per side via `<g data-net="pN">`. Pin slot indices: -50, -30, -10, +10, +30, +50 (horizontal offset from `cx`, viewBox units). Below table defines a UNIQUE elbow-y per pin slot per chip so no two pin-drops within a chip share an elbow.

**P1 — cx=137 (leftmost, drops LEFT toward CN1):**

| Pin slot | Bus tap  | Elbow y | Path pattern (Manhattan + 45° chamfers, 3vu chamfer)              |
|----------|----------|---------|-------------------------------------------------------------------|
| -50      | CN1      | 24      | `M87 0 v6 l-4 4 v8 h-30`  (drops left into CN1 row)              |
| -30      | VCC      | 10      | `M107 0 v4 l-3 3 v3 h-40 l-4 -4 v-6`  (jogs left to VCC@y=6)     |
| -10      | SDA      | 14      | `M127 0 v8 l3 3 v3 h0`  (taps SDA@y=18 directly below)           |
| +10      | (private)| 22      | `M147 0 v18 h12`  (dead-end private trace to via at x=159,y=18)  |
| +30      | VCC      | 4       | `M167 0 v2 l-3 -3` … wait — rethink: bus taps go DOWN to bus. Correct: `M167 0 v0 l-3 3` not used; instead `M167 0 v4 l3 -3 v-3` → tap VCC at top |
| +50      | CN1stub  | 28      | `M187 0 v22 l-4 4 v2 h-90 l-4 -4 v-26`  (long left-route to CN1 lower) |

> Path syntax note: drop-paths originate at the chip's bottom pin tab (y=0 of the SVG strip = pin tab attachment line). Pins land on `y=0` of viewBox because the SVG strip sits BELOW the HTML chip; the chip's pin tabs anchor at strip top-edge.

**P2 — cx=412 (has crystal Y1 + bulk cap C1 adjacent):**

| Pin slot | Bus tap  | Elbow y | Notes                                                              |
|----------|----------|---------|--------------------------------------------------------------------|
| -50      | VCC      | 12      | Drops to VCC via 45° jog                                          |
| -30      | C1 pad   | 20      | Routes to bulk cap C1 placed at (x=380, y=20)                     |
| -10      | SDA      | 18      | Taps SDA bus directly                                              |
| +10      | OSC_top  | 24      | Routes DOWN through strip via to OSC bus (bottom strip y=18)      |
| +30      | SCL      | 32      | Long drop to SCL bus (chamfer at y=24)                            |
| +50      | Y1 pad-A | 16      | Routes to Crystal Y1 pad at (x=465, y=14)                         |

**P3 — cx=687 (has SOT-23 transistor Q1 + resistor R1 adjacent):**

| Pin slot | Bus tap  | Elbow y | Notes                                                              |
|----------|----------|---------|--------------------------------------------------------------------|
| -50      | SDA      | 18      | Direct SDA tap                                                     |
| -30      | R1 pad   | 26      | Routes to pull-up resistor R1 at (x=665, y=26)                    |
| -10      | SCL      | 32      | Direct SCL tap                                                     |
| +10      | Q1 base  | 22      | Routes to SOT-23 Q1 base pad at (x=702, y=22)                     |
| +30      | VCC      | 8       | 45° jog to VCC                                                     |
| +50      | Y1 pad-B | 14      | Crosses back to share crystal Y1 with P2                          |

**P4 — cx=962 (rightmost, drops RIGHT toward CN2 + regulator U1):**

| Pin slot | Bus tap  | Elbow y | Notes                                                              |
|----------|----------|---------|--------------------------------------------------------------------|
| -50      | SCL      | 32      | Direct SCL tap (long elbow)                                       |
| -30      | VCC      | 6       | Direct VCC tap                                                     |
| -10      | (private)| 16      | Private trace to via at x=952, y=16                               |
| +10      | U1_VIN   | 24      | Routes to regulator U1 input at (x=1010, y=24)                    |
| +30      | CN2      | 14      | Routes right into CN2 edge connector                              |
| +50      | CN2      | 22      | Routes right into CN2 edge connector (second pin)                 |

**Verification:** Every chip's six pin slots map to six DISTINCT elbow-y values, satisfying criterion 9.b.

### 1.4 Manhattan + 45° chamfer convention

Replace v11 pure-90° elbows. Every corner uses a 3vu diagonal chamfer:

```
v11:   M{cx-50} 0 V14 H{cx-58}                    (90° corner)
v12:   M{cx-50} 0 v11 l-3 3 h-5                   (chamfered at y=11→14)
```

Cumulative effect: ~50–80 chamfer instances across the two strips. Eliminates the "auto-routed" tell.

### 1.5 Off-board card-edge fingers (CN1/CN2 visible at strip endpoints)

**CN1 (left edge of top strip):**
- 6 rectangular pads stacked vertically at `x=0..18`, `y=4,11,18,25,32,39`, size `18×4vu`, `rx=0.5`
- Brighter gold fill (`var(--csb-pad-fill)`), no silkscreen overlay
- Implies card-edge connector running off-banner

**CN2 (right edge of top strip):**
- Same 6-pad pattern mirrored at `x=1082..1100`

**CN3 (left edge of bottom strip):** 4 pads at `x=0..18`, `y=8,18,28,38`, `12×4vu`
**CN4 (right edge of bottom strip):** 4 pads at `x=1082..1100` mirrored

---

## 2. COMPONENT PLACEMENT TABLE

Total: **9 distinct footprint categories, 24 instances**.

### 2.1 Top strip components

| # | Designator | Footprint        | viewBox pos (x,y) | Size      | Notes                                |
|---|------------|------------------|-------------------|-----------|--------------------------------------|
| 1 | CN1        | card-edge (6-pin)| 0..18, 4..43      | 18×4 ×6  | Left edge connector pads             |
| 2 | CN2        | card-edge (6-pin)| 1082..1100        | 18×4 ×6  | Right edge connector pads            |
| 3 | C1         | 0402 cap         | (380, 20)         | 10×5     | P2 bulk cap (VCC ↔ GND via)          |
| 4 | C2         | 0402 cap         | (412, 4)          | 10×5     | P2 VCC decoupling (above chip)       |
| 5 | C3         | 0402 cap         | (687, 4)          | 10×5     | P3 VCC decoupling                    |
| 6 | C4         | 0402 cap         | (962, 4)          | 10×5     | P4 VCC decoupling                    |
| 7 | C5         | 0402 cap         | (137, 4)          | 10×5     | P1 VCC decoupling                    |
| 8 | R1         | 0603 resistor    | (665, 26)         | 12×6     | I²C pull-up (P3 -30)                 |
| 9 | R2         | 0603 resistor    | (655, 32)         | 12×6     | I²C pull-up (SCL → VCC)              |
| 10| Q1         | SOT-23 transistor| (702, 22)         | 3 pads   | P3 sideband transistor               |
| 11| Y1         | crystal          | (450, 12)         | 30×16    | P2↔P3 shared clock                   |
| 12| Fiducial-TL| 3-circle fiducial| (10, 8)           | r=4       | Top-left assembly mark               |
| 13| Fiducial-TR| 3-circle fiducial| (1090, 8)         | r=4       | Top-right assembly mark              |

### 2.2 Bottom strip components

| # | Designator | Footprint        | viewBox pos (x,y) | Size      | Notes                                |
|---|------------|------------------|-------------------|-----------|--------------------------------------|
| 14| CN3        | card-edge (4-pin)| 0..18             | 12×4 ×4  | Bottom-left edge connector           |
| 15| CN4        | card-edge (4-pin)| 1082..1100        | 12×4 ×4  | Bottom-right edge connector          |
| 16| L1         | inductor coil    | (200, 24)         | 50×12    | Power-input inductor                 |
| 17| C6         | 0402 cap         | (270, 24)         | 10×5     | Post-inductor bulk cap               |
| 18| C7         | 0402 cap         | (290, 24)         | 10×5     | Post-inductor bulk cap (parallel)    |
| 19| D1         | diode            | (340, 22)         | 14×10    | Reverse-polarity protection          |
| 20| U1         | SOT-89 regulator | (1010, 22)        | 30×12    | LDO regulator near right edge        |
| 21| C8         | 0402 cap         | (1050, 30)        | 10×5     | LDO output bypass cap                |
| 22| R3         | 0603 resistor    | (980, 28)         | 12×6     | LDO feedback resistor                |
| 23| Fiducial-BL| 3-circle fiducial| (10, 36)          | r=4       | Bottom-left assembly mark            |
| 24| Fiducial-BR| 3-circle fiducial| (1090, 36)        | r=4       | Bottom-right assembly mark           |

**Distinct footprint categories:** card-edge (4), 0402 cap (8), 0603 resistor (3), SOT-23 (1), crystal (1), inductor (1), diode (1), SOT-89 regulator (1), fiducial (4) = **9 categories, 24 instances**.

### 2.3 Footprint rendering details (lifted from CircuitTraces catalog)

**0402 cap (10×5 viewBox units):**
```jsx
<g className={styles.csbCap}>
  <rect x={cx-5} y={cy-2.5} width="10" height="5" rx="0.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.6"
        vectorEffect="non-scaling-stroke" />
  <rect x={cx-5} y={cy-2.5} width="2" height="5" fill="var(--csb-pad-fill)" />
  <rect x={cx+3} y={cy-2.5} width="2" height="5" fill="var(--csb-pad-fill)" />
</g>
```

**0603 resistor (12×6):**
```jsx
<g className={styles.csbResistor}>
  <rect x={cx-6} y={cy-3} width="12" height="6" rx="0.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.6"
        vectorEffect="non-scaling-stroke" />
  <rect x={cx-6} y={cy-3} width="2.5" height="6" fill="var(--csb-pad-fill)" />
  <rect x={cx+3.5} y={cy-3} width="2.5" height="6" fill="var(--csb-pad-fill)" />
</g>
```

**SOT-23 (3-pad triangle, ~12×8 bbox):**
```jsx
<g className={styles.csbTransistor}>
  <rect x={cx-2} y={cy-2.5} width="4" height="3" fill="var(--csb-pad-fill)" />
  <rect x={cx+2} y={cy-2.5} width="4" height="3" fill="var(--csb-pad-fill)" />
  <rect x={cx} y={cy+2.5} width="4" height="3" fill="var(--csb-pad-fill)" />
</g>
```

**Crystal Y1 (30×16):**
```jsx
<g className={styles.csbCrystal}>
  <rect x={cx-15} y={cy-8} width="30" height="16" rx="3"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="1.2"
        vectorEffect="non-scaling-stroke" />
  <rect x={cx-13} y={cy-6} width="4" height="4" rx="0.5" fill="var(--csb-pad-fill)" />
  <rect x={cx+9}  y={cy-6} width="4" height="4" rx="0.5" fill="var(--csb-pad-fill)" />
  <rect x={cx-13} y={cy+2} width="4" height="4" rx="0.5" fill="var(--csb-pad-fill)" />
  <rect x={cx+9}  y={cy+2} width="4" height="4" rx="0.5" fill="var(--csb-pad-fill)" />
</g>
```

**Inductor L1 (50×12, cubic-bezier spiral):**
```jsx
<g className={styles.csbInductor}>
  <path d={`M${cx-25} ${cy} C${cx-22} ${cy-6}, ${cx-15} ${cy-6}, ${cx-12} ${cy}
            C${cx-9} ${cy-6}, ${cx-2} ${cy-6}, ${cx+1} ${cy}
            C${cx+4} ${cy-6}, ${cx+11} ${cy-6}, ${cx+14} ${cy}
            C${cx+17} ${cy-6}, ${cx+22} ${cy-6}, ${cx+25} ${cy}`}
        fill="none" stroke="var(--csb-ic-stroke)" strokeWidth="1.4"
        vectorEffect="non-scaling-stroke" />
  <rect x={cx-29} y={cy-3} width="7" height="6" rx="1" fill="var(--csb-pad-fill)" />
  <rect x={cx+22} y={cy-3} width="7" height="6" rx="1" fill="var(--csb-pad-fill)" />
</g>
```

**Diode D1 (14×10):**
```jsx
<g className={styles.csbDiode}>
  <path d={`M${cx-7} ${cy-5} L${cx+5} ${cy} L${cx-7} ${cy+5} Z`}
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.8"
        vectorEffect="non-scaling-stroke" />
  <line x1={cx+5} y1={cy-5} x2={cx+5} y2={cy+5}
        stroke="var(--csb-ic-stroke)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
</g>
```

**SOT-89 regulator U1 (30×12):**
```jsx
<g className={styles.csbRegulator}>
  <rect x={cx-15} y={cy-6} width="30" height="12" rx="1.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="1.2"
        vectorEffect="non-scaling-stroke" />
  <rect x={cx-13} y={cy+5} width="6" height="3" fill="var(--csb-pad-fill)" />
  <rect x={cx-3}  y={cy+5} width="6" height="3" fill="var(--csb-pad-fill)" />
  <rect x={cx+7}  y={cy+5} width="6" height="3" fill="var(--csb-pad-fill)" />
  <rect x={cx-9}  y={cy-8} width="18" height="3" fill="var(--csb-pad-fill)" />
</g>
```

**Fiducial (3 concentric circles, r=4 outer):**
```jsx
<g className={styles.csbFiducial}>
  <circle cx={x} cy={y} r="4"   fill="none" stroke="var(--csb-node)" strokeWidth="0.5"
          vectorEffect="non-scaling-stroke" />
  <circle cx={x} cy={y} r="2"   fill="none" stroke="var(--csb-node)" strokeWidth="0.5"
          vectorEffect="non-scaling-stroke" />
  <circle cx={x} cy={y} r="0.8" fill="var(--csb-node)" />
</g>
```

**Via dot (2-circle):**
```jsx
<g className={styles.csbVia}>
  <circle cx={x} cy={y} r="2"   fill="var(--csb-node)" fillOpacity="0.20"
          stroke="var(--csb-node)" strokeOpacity="0.50" strokeWidth="0.6"
          vectorEffect="non-scaling-stroke" />
  <circle cx={x} cy={y} r="0.8" fill="var(--csb-node)" fillOpacity="0.75" />
</g>
```

---

## 3. SILKSCREEN LABELS

Adds **NEW grammar** not present in CircuitTraces (which has zero `<text>` elements). Reserve a dedicated `--csb-silkscreen` token + `.csbSilkscreen` class.

**Font specification:**
- `font-family: var(--font-mono)` (`ui-monospace, SF Mono`)
- `font-size: 4px` in viewBox units (renders ~3 CSS px at 1369px-wide board, ~3.5 CSS px at 1920px)
- `fill: var(--csb-silkscreen)`
- `letter-spacing: 0.05em`
- `text-anchor` per-label (mostly `middle`; `start`/`end` near edges)
- `dominant-baseline: middle` for vertical centering on `(x, y)` anchor

**Position rule:** Labels for components in the **TOP strip** sit ABOVE the component (lower y in viewBox). Labels in the **BOTTOM strip** sit BELOW (higher y). Exception: labels near the strip top/bottom edge flip to the available side.

### 3.1 Top strip silkscreen

| Designator | Anchor x | Anchor y | text-anchor | Notes                            |
|------------|----------|----------|-------------|----------------------------------|
| U1         | 137      | 41       | middle      | Below chip pin row (chip = HTML)|
| U2         | 412      | 41       | middle      |                                  |
| U3         | 687      | 41       | middle      |                                  |
| U4         | 962      | 41       | middle      |                                  |
| C1         | 380      | 14       | middle      | Above 0402 cap at y=20           |
| C2         | 412      | 0        | middle      | Above strip top (clip-allowed)   |
| C3         | 687      | 0        | middle      |                                  |
| C4         | 962      | 0        | middle      |                                  |
| C5         | 137      | 0        | middle      |                                  |
| R1         | 665      | 20       | middle      | Above resistor at y=26           |
| R2         | 655      | 26       | end         | Tight fit between resistor + bus |
| Q1         | 702      | 16       | middle      |                                  |
| Y1         | 450      | 4        | middle      | Above crystal at y=12            |

### 3.2 Bottom strip silkscreen

| Designator | Anchor x | Anchor y | text-anchor | Notes                            |
|------------|----------|----------|-------------|----------------------------------|
| L1         | 200      | 36       | middle      | Below inductor at y=24           |
| C6         | 270      | 32       | middle      |                                  |
| C7         | 290      | 32       | middle      |                                  |
| D1         | 340      | 32       | middle      | Below diode body                 |
| R3         | 980      | 36       | middle      |                                  |
| U1 (reg)   | 1010     | 36       | middle      | Distinct from top-strip "U1" — could rename to "VR1" for unambiguous |
| C8         | 1050     | 38       | middle      |                                  |

**Recommendation:** rename top-strip chip designators to `U1..U4` and bottom-strip regulator to `VR1` to avoid collision with the top-strip MCU designators. Crystal stays `Y1`, all caps `C1..C8`, all resistors `R1..R3`, transistor `Q1`, diode `D1`, inductor `L1`.

### 3.3 Corner legend block (top-right of top strip)

Render in 9px mono at 40% opacity:
```
CIRCUITS.COM   REV.A   2026-W22
```

Positioned at `(1060, 4)` with `text-anchor="end"`. Optional `<rect>` outline behind it at 12% opacity to set off as legend bezel.

### 3.4 Polarity markers

Tiny pin-1 dots on each component that has orientation:
- **Q1 (SOT-23):** `<circle cx={702-2} cy={22-3} r="0.6" fill="var(--csb-silkscreen)" />` (pin-1 dot top-left)
- **U1 / VR1 (regulator):** Pin-1 dot at top-left of body rect
- **D1 (diode):** Cathode bar already implicit in geometry; add `'K'` silkscreen letter near bar end

---

## 4. CSS TOKEN VOCABULARY

New custom properties defined on `.board` root (mirrors CircuitTraces six-token pattern, expanded to seven for silkscreen + power-bus variant). All defined on the BOARD ROOT, not per child (perf — same lesson as CircuitTraces).

```scss
.board {
  // Gold trace primary
  --csb-trace:       color-mix(in srgb, var(--gold) 65%, transparent);
  --csb-trace-bus:   color-mix(in srgb, var(--gold) 85%, transparent);   // VCC/GND/PWR_IN

  // Component bodies
  --csb-ic-stroke:   color-mix(in srgb, var(--gold) 50%, transparent);
  --csb-ic-fill:     color-mix(in srgb, var(--gold) 6%,  transparent);   // FR4 body tint
  --csb-pad-fill:    color-mix(in srgb, var(--gold) 75%, transparent);   // exposed copper pads

  // Vias + dots
  --csb-node:        color-mix(in srgb, var(--gold) 70%, transparent);

  // Silkscreen text + outlines (cooler, off-white-tinted gold)
  --csb-silkscreen:  color-mix(in srgb, #f5e9c0 55%, transparent);
}
```

**Three-tone hierarchy** (research recommendation #6):
- **Pads / vias / power buses:** brightest tone (`--csb-pad-fill`, `--csb-trace-bus`, `--csb-node`)
- **Signal traces / IC outlines:** mid tone (`--csb-trace`, `--csb-ic-stroke`)
- **Silkscreen text + IC body fills:** cool desaturated off-gold (`--csb-silkscreen`, `--csb-ic-fill`)

---

## 5. STROKE WIDTHS

Apply `vector-effect="non-scaling-stroke"` on EVERY stroked element (path, line, circle, rect) inside the strips. Without this, `preserveAspectRatio="none"` distorts horizontal strokes thicker on wide rails.

| Element class       | Stroke width (CSS px target) | Notes                              |
|---------------------|------------------------------|------------------------------------|
| `.busPower`         | 3.5                          | PWR_IN rail (new heaviest tier)    |
| `.busVcc`, `.busGnd`| 3.0                          | Power rails (top + bottom edges)   |
| `.busSignal`        | 2.2                          | SDA, SCL, OSC                      |
| `.pinDrop`          | 2.0                          | Chip pin → bus vertical traces     |
| `.anchorStub`       | 1.4                          | Decorative short anchor segments   |
| `.icOutline`        | 1.2                          | Component body strokes (SOT-89, Crystal, IC) |
| `.smdOutline`       | 0.6–0.8                      | 0402/0603/SOT-23/diode             |
| `.fiducialRing`     | 0.5                          | Fiducial concentric rings          |
| `.viaRing`          | 0.6                          | Via outer ring                     |

**Comparison to v11:**
- v11 .busVcc/.busGnd: 2.2px → v12: 3.0px (+36%)
- v11 .traces: 1.6px → v12: 2.0px pin drops (+25%)
- v11 .tracesFaint: 1.4px @ 28% → v12: 1.4px @ 50% anchor stubs (opacity boost solves the perceptibility complaint)

---

## 6. CLICK-TO-ENERGIZE — preserved from v11

The grouping convention is unchanged:

```jsx
<svg viewBox="0 0 1100 43" preserveAspectRatio="none">
  {/* Shared infrastructure — outside any data-net */}
  <line className={styles.busVcc} ... />
  <line className={styles.busGnd} ... />
  <line className={styles.busSignal} ... />     {/* SDA */}
  <line className={styles.busSignal} ... />     {/* SCL */}
  <g className={styles.csbFiducial}>...</g>
  <CN1 /> <CN2 />                                {/* edge connectors are always lit */}

  {/* Per-chip private drop traces + components */}
  <g data-net="p1">
    {/* P1's 6 drop paths, P1-private vias, C5 cap above U1 */}
  </g>
  <g data-net="p2">
    {/* P2's 6 drop paths, C1+C2 caps, Y1 crystal, Y1-related vias */}
  </g>
  <g data-net="p3">
    {/* P3's 6 drop paths, R1+R2 resistors, Q1 transistor, C3 cap */}
  </g>
  <g data-net="p4">
    {/* P4's 6 drop paths, C4 cap */}
  </g>
</svg>
```

**Shared components** (crystal Y1 used by both P2 and P3): place in the `data-net` of the LOWER-index chip (P2) so a P2 click energizes Y1; P3's click does NOT re-energize Y1 (prevents flicker). This is consistent with v11's shared-bus convention.

**Click duration:** unchanged at 4500ms (the `csb-chip-charge` keyframe in `.module.scss`).

**Click handler:** unchanged — `BoardShell` + `ChipPinRow` continue to dispatch `data-energized="true"` on the matching `<g data-net="pN">` for 4500ms.

---

## 7. ANIMATION HOOKS (v13+, RESERVED — not implemented in v12)

Establish the data-attribute API now so v13 can layer animations without refactoring the SVG:

| Selector                              | Reserved for                                       |
|---------------------------------------|----------------------------------------------------|
| `.csbCap[data-energized="true"]`      | Charge-pulse: pad fill flash + brief glow          |
| `.csbDiode[data-energized="true"]`    | Forward-bias glow: body fill warms toward saturated gold |
| `.csbResistor[data-energized="true"]` | Heat shimmer: subtle hue oscillation (CPU-cheap option: opacity pulse) |
| `.csbCrystal[data-energized="true"]`  | Oscillation: pads alternate brightness 50ms cadence |
| `.csbVia[data-energized="true"]`      | Pinhole pulse on inner circle                      |

**v12 implementation note:** these classes are stamped but NO `[data-energized]` styling is added in the SCSS. The click handler is also NOT yet expanded to flip these attributes — that's v13 scope.

---

## 8. PRESERVE-AS-IS

The following code surfaces are LOAD-BEARING for the v11 architectural wins and stay untouched in v12:

### 8.1 TSX
- `CopyChip` (lines ~73–102) — setTimeout cleanup on unmount + native-button safe
- `SponsorMedallion` (lines ~57–71) — medallion SVG art (separate from board strips)
- `BoardShell` (lines ~415–450) — wraps the 220px banner + click handler
- `ChipPinRow` (lines ~452–474) — HTML chip pin rendering inside chip wrapper
- `CategorySponsorBanner` default export (lines ~476–650) — Rail JSX + HTML chip layout
- `CHIP_X = { p1: 137, p2: 412, p3: 687, p4: 962 }` constant
- `chipStyle` width/center calculation (the HTML/SVG coordinate-lock)

### 8.2 SCSS
- `.field` (board frame)
- `.chipPins` (HTML chip pin tabs)
- `.id` (chip designator text inside HTML chip)
- `.kicker`, `.cta`, `.copyChip` (CTA region)
- `.csbChipCharge` keyframe (4500ms)
- `@media (prefers-reduced-motion: reduce)` block (disables `.csbChipCharge`)

### 8.3 Banner geometry
- Total height: **220px**
- Vertical stack: **6 + 43 + 11 + 100 + 11 + 43 + 6 = 220** (top margin, top strip, chip-to-strip gap, chip row, gap, bottom strip, bottom margin)
- Mobile breakpoint: **≤1080px** — SVG strips set to `display: none`, chips reflow to CSS grid (per v11 module.scss)

### 8.4 Constants to RENAME (v11 → v12)
- `TOP_STUB_DX` / `BOT_STUB_DX` → DELETED. Replaced by per-chip routing functions `P1Net()`, `P2Net()`, `P3Net()`, `P4Net()` inside `BoardArt` / `BottomBoardArt`. Each function returns the JSX for that chip's private traces + adjacent components.

---

## 9. VERIFICATION CRITERIA

After implementation, run the following checks. ALL must pass before commit.

### 9.a Bus stroke-width measurement
- Open `/category/microcontrollers` (or any parent category with a sponsor) at viewport 1440×900
- DevTools → inspect the `.busVcc` line element
- `getComputedStyle(el).strokeWidth` must report **≥ 1.8px** (target 3.0px; min acceptable 1.8px allowing for sub-pixel rounding)

### 9.b Pin-drop elbow uniqueness (per chip)
- Inspect each `<g data-net="pN">` group
- The y-coordinates of the chamfer landings for the 6 pin drops within that group must form a **set of 6 distinct values**
- Quick check: `Array.from(document.querySelectorAll('[data-net=p1] path')).map(p => /v(\d+)/.exec(p.getAttribute('d'))?.[1])` should return 6 unique strings

### 9.c Per-chip distinct adjacent component
Each chip's `data-net` group must contain at least ONE component category that DIFFERS from the other chips' groups:
- **P1:** CN1 routing (unique: edge-connector taps)
- **P2:** Y1 crystal + C1 bulk cap (unique: crystal)
- **P3:** Q1 transistor + R1/R2 resistors (unique: SOT-23)
- **P4:** CN2 routing + VR1 regulator (unique: regulator)

Verify visually: screenshot at 1440×900 — the four chips should NOT be visually interchangeable.

### 9.d Silkscreen legibility
- Screenshot at 1440×900
- Zoom to 200% in image viewer
- Designators `U1`, `R1`, `C1`, etc. must be **readable** (not blurred into traces)
- If silkscreen reads as noise, increase `--csb-silkscreen` from 55% to 65% mix

### 9.e Edge connectors visible
- CN1 pads visible at x=0..18 of top strip
- CN2 pads visible at x=1082..1100 of top strip
- Both groups must render at 1440px AND at 1920px AND at 1280px (no clipping)

### 9.f ESLint
```bash
cd frontend && npx eslint src/public/pages/category/components/CategorySponsorBanner.tsx
```
Exit 0 required.

### 9.g TypeScript
```bash
cd frontend && npx tsc --noEmit
```
Exit 0 required. The post-tool-use hook will also re-run this.

### 9.h Click-to-energize still works
- Click each chip in turn
- The HTML chip body and ONLY that chip's `<g data-net>` group should energize (4500ms)
- Shared buses (VCC/GND/SDA/SCL/OSC/PWR_IN) and shared components (Y1, fiducials, CN1/CN2/CN3/CN4) MUST remain at their always-on opacity (no flicker when clicked)

### 9.i Mobile reflow
- Resize viewport to ≤1080px
- SVG strips (`BoardArt`, `BottomBoardArt`) MUST be `display: none`
- HTML chips MUST reflow to 2×2 or 1×4 CSS grid (per v11 module.scss `@media (max-width: 1080px)` block)
- CTA + Copy chip + Medallion stay visible

### 9.j Visual diff vs v11
- Take screenshots at 1440×900 of v11 (commit c69b439) and v12 board surface
- Side-by-side overlay (or `compare` from ImageMagick): the diff must affect **≥ 60% of the board pixels**
- Spot check: presence of silkscreen text, presence of SMT components in strips, presence of CN1/CN2 fingers, asymmetric routing per chip — none of these existed in v11.

---

## 10. IMPLEMENTATION NOTE — file layout

All edits land in two files only:

1. **`frontend/src/public/pages/category/components/CategorySponsorBanner.tsx`**
   - Replace `BoardArt` function body (~lines 128–271)
   - Replace `BottomBoardArt` function body (~lines 296–414)
   - Delete `TOP_STUB_DX` / `BOT_STUB_DX` constants (lines ~26–27)
   - Add four per-chip route functions `P1Net()`, `P2Net()`, `P3Net()`, `P4Net()` (top strip) and one bottom-strip composition function

2. **`frontend/src/public/pages/category/components/CategorySponsorBanner.module.scss`**
   - Add 7 new CSS custom properties on `.board` (Section 4)
   - Add classes: `.csbCap`, `.csbResistor`, `.csbTransistor`, `.csbCrystal`, `.csbInductor`, `.csbDiode`, `.csbRegulator`, `.csbFiducial`, `.csbVia`, `.csbSilkscreen`, `.busPower`, `.pinDrop`, `.anchorStub`, `.icOutline`, `.smdOutline`, `.fiducialRing`, `.viaRing`
   - Update existing widths per Section 5 table
   - PRESERVE all v11 chip / CTA / copyChip / medallion / mobile-reflow / keyframe / reduced-motion blocks unchanged

No other files touched. No new components, no new modules. The grammar additions live entirely inside the existing two-file pair.

---

## 11. OPEN QUESTIONS / FOLLOW-UPS

1. **Designator collision:** top-strip uses `U1..U4` for chips; bottom-strip regulator is also `U1` historically. v12 renames regulator to `VR1`. Confirm with user that `VR1` reads correctly (some PCB conventions use `VR1` for variable resistor; `U5` or `LDO1` are alternatives).
2. **Color of decoupling caps when energized (v13):** confirm whether warm-amber (saturated `--gold`) or cooler-white pulse reads better against the FR4-gold background.
3. **Click energizes shared components?** Spec says NO (Y1 only energizes on P2 click). Alternative: P2 OR P3 click both energize Y1 (mark Y1 with `data-net="p2 p3"` and adjust selector). Defer decision to v13.

---

*End of v12 spec. Implementation produces a board strip that reads as a real PCB ad at hero scale rather than as a wireframe schematic, while preserving the v11 architectural wins (HTML+SVG coordinate lock, click-to-energize, mobile reflow, monochrome gold theme integration).*
