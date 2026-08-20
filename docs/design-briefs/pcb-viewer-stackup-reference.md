# PCB viewer — Stackup view (owner reference, 2026-08-19)

Owner supplied an Altium 365 Viewer screenshot of its **Stackup** tab as the
reference for what the PCB tool should show. Captured here so the PCB-viewer
spec (a separate project from the BOM tool) starts from the real requirement.

## What the reference shows

Three zones, left to right:

1. **Cross-section render** — the physical stack drawn to scale: green solder
   mask on top, copper layers as thin bright bands, prepreg/core dielectrics as
   thick olive bands, and plated through-holes drawn as barrels/trapezoids
   crossing the stack. Leader lines connect each band to its table row.
2. **Layer table** — columns `# | Layer | Type | Thk (mm)`. Copper layers carry
   an ordinal (1..5); dielectrics show `-` and a D-prefixed name.

   | # | Layer | Type | Thk (mm) |
   |---|---|---|---|
   | - | Top Overlay | Overlay | — |
   | - | Top Solder | Solder Mask | 0.0100 |
   | 1 | Top | Signal | 0.0450 |
   | - | D1 | Prepreg | 0.1000 |
   | 2 | GND1 | Plane | 0.0180 |
   | - | D2 | Core | 0.1500 |
   | 3 | L3 | Signal | 0.0180 |
   | - | D3 | Prepreg | 0.3200 |
   | 4 | Power | Plane | 0.0350 |
   | - | D4 | Core | 0.1500 |
   | 5 | L5 | Signal | 0.0350 |
   | - | D5 | Prepreg | 0.3200 |

3. **Summary panel** — Total Layers 8, Signal 5, Plane 3, Dielectric 7,
   Thickness 1.542 mm, Thru via 1607, Blind/Buried via 0/0.

## The architectural implication (this answers an open question)

The owner's original brief asked whether the PCB tool should read the
**KiCad PCB file** or **Gerbers**, and said he did not know which was right.
The stackup requirement decides it:

- **Bare Gerbers (RS-274X) carry no stackup at all** — no layer types, no
  thicknesses, no material. They are per-layer imagery plus a drill file. Layer
  ROLE is guessed from filename convention, which is not reliable.
- **`.kicad_pcb` stores the board stackup** (Board Setup -> Physical Stackup):
  ordered layers, type, thickness, material, dielectric constant, loss tangent.
- **The Gerber job file (`.gbrjob`, Gerber X2)** also carries stackup metadata
  and is emitted alongside a KiCad Gerber export.

So a stackup view requires the design file or the job file. If the tool accepts
only a folder of bare Gerbers, this entire panel is unbuildable — and the
via counts (1607 thru / 0 blind-buried) additionally require drill-file parsing.

VERIFY before speccing: the exact `.kicad_pcb` stackup s-expression and the
`.gbrjob` schema. Research was in flight when this note was written.

## Honesty constraint

Every number in that panel is a measured property of a real board. If a field
cannot be derived from what the user uploaded, the row must be absent or
explicitly unknown - never defaulted. A fabricated 1.6 mm total thickness or a
guessed via count is exactly the failure this project has ruled out elsewhere
(see the banned fake SUB-ID rows on the Silver receipt, and the lifecycle
default-vs-verified decision in the BOM tool).
