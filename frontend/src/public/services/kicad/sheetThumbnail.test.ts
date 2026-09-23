import { describe, expect, it } from 'vitest';
import { atom, child, children, parse } from './sexpr';
import { fixtureText, hasFixture } from './fixtures';
import { placePoint, placedPins, readSheetThumbnail } from './sheetThumbnail';

const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

/** Everything on a sheet a pin can legitimately land on. */
function connectionPoints(text: string): Set<string> {
  const doc = parse(text)[0] as unknown[];
  const num = (s: string | null) => Number(s ?? 'NaN');
  const out = new Set<string>();
  for (const kind of ['wire', 'bus']) {
    for (const w of children(doc as never, kind)) for (const p of children(child(w, 'pts') ?? [], 'xy')) out.add(key(num(atom(p, 1)), num(atom(p, 2))));
  }
  for (const kind of ['junction', 'no_connect', 'label', 'global_label', 'hierarchical_label']) {
    for (const j of children(doc as never, kind)) {
      const a = child(j, 'at');
      if (a != null) out.add(key(num(atom(a, 1)), num(atom(a, 2))));
    }
  }
  return out;
}

const SMALL = `(kicad_sch (version 20230121) (generator eeschema)
  (uuid 0)
  (paper "User" 100 60)
  (lib_symbols
    (symbol "Device:R" (in_bom yes) (on_board yes)
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
      )
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
    (symbol "Device:R_Small" (extends "R"))
    (symbol "Device:C" (in_bom yes)
      (symbol "C_0_1"
        (arc (start -2 0) (mid 0 1) (end 2 0) (stroke (width 0.254) (type default)) (fill (type none)))
        (circle (center 0 0) (radius 0.5) (stroke (width 0.254) (type default)) (fill (type none)))
      )
      (symbol "C_1_2" (polyline (pts (xy 0 0) (xy 9 9))))
    )
  )
  (junction (at 20 30) (diameter 0) (color 0 0 0 0) (uuid j1))
  (wire (pts (xy 10 30) (xy 20 30)) (stroke (width 0) (type default)) (uuid w1))
  (wire (pts (xy 20 30) (xy 20 40)) (stroke (width 0) (type default)) (uuid w2))
  (bus (pts (xy 50 10) (xy 50 50)) (stroke (width 0) (type default)) (uuid b1))
  (symbol (lib_id "Device:R") (at 30 30 90) (unit 1) (uuid s1)
    (property "Reference" "R1" (at 0 0 0)))
  (symbol (lib_id "Device:R_Small") (at 40 30 0) (mirror y) (unit 1) (uuid s2))
  (symbol (lib_id "Device:C") (at 60 30 0) (unit 1) (uuid s3))
  (symbol (lib_id "Missing:Part") (at 70 30 0) (unit 1) (uuid s4))
  (sheet (at 80 10) (size 15 20) (uuid sh1)
    (property "Sheetname" "sub" (at 80 9 0))
    (property "Sheetfile" "sub.kicad_sch" (at 80 31 0)))
)`;

describe('placePoint', () => {
  it('flips the library y, mirrors in the library frame and turns counter-clockwise on the sheet', () => {
    // A pin 3.81 ABOVE the symbol origin in the library sits 3.81 above it on
    // the sheet (y down) when unrotated…
    expect(placePoint([0, 3.81], { x: 30, y: 30, rot: 0, mirror: null })).toEqual([30, 30 - 3.81]);
    // …and turned 90° counter-clockwise on the page it points LEFT.
    const [x, y] = placePoint([0, 3.81], { x: 30, y: 30, rot: 90, mirror: null });
    expect(x).toBeCloseTo(30 - 3.81);
    expect(y).toBeCloseTo(30);
    // (mirror x) flips across the X axis: above becomes below.
    expect(placePoint([0, 3.81], { x: 30, y: 30, rot: 0, mirror: 'x' })).toEqual([30, 30 + 3.81]);
    // (mirror y) flips across the Y axis: right becomes left.
    expect(placePoint([2, 0], { x: 30, y: 30, rot: 0, mirror: 'y' })).toEqual([28, 30]);
  });
});

describe('readSheetThumbnail', () => {
  it('reads the paper, the wires and buses, the junctions, the placed symbols and the sheet boxes', () => {
    const t = readSheetThumbnail(SMALL)!;
    expect(t).not.toBeNull();
    expect([t.width, t.height]).toEqual([100, 60]);
    expect(t.counts).toEqual({ wires: 2, buses: 1, symbols: 3, sheets: 1, pins: 4 });
    expect(t.wires).toBe('M10 30L20 30M20 30L20 40');
    expect(t.buses).toBe('M50 10L50 50');
    expect(t.junctions).toEqual([{ x: 20, y: 30 }]);
    expect(t.sheets).toBe('M80 10L95 10L95 30L80 30Z');
    // The rectangle of R at 90°: a closed run of four corners, rotated; the
    // arc and circle of C: an open three-point run and a closed 12-gon; the
    // derived R_Small draws its parent's body. The unknown lib_id is skipped.
    // R: the body and two pins; R_Small: the same three through `extends`;
    // C: the arc and the circle. Eight runs.
    expect(t.symbols.split('M').length - 1).toBe(3 + 3 + 2);
    expect(t.symbols).toContain('Z');
    // C's DeMorgan alternate (style 2) is never drawn.
    expect(t.symbols).not.toContain('L69 21');
  });

  it('takes a named paper, turns it portrait when asked, and falls back to A4', () => {
    expect(readSheetThumbnail('(kicad_sch (paper "A3"))')).toMatchObject({ width: 420, height: 297 });
    expect(readSheetThumbnail('(kicad_sch (paper "A3" portrait))')).toMatchObject({ width: 297, height: 420 });
    expect(readSheetThumbnail('(kicad_sch (paper "Nope"))')).toMatchObject({ width: 297, height: 210 });
    expect(readSheetThumbnail('(kicad_sch)')).toMatchObject({ width: 297, height: 210, wires: '', symbols: '' });
  });

  it('answers null for anything that is not a schematic', () => {
    expect(readSheetThumbnail('(kicad_pcb (version 1))')).toBeNull();
    expect(readSheetThumbnail('not a file')).toBeNull();
    expect(readSheetThumbnail('(kicad_sch (paper')).toBeNull();
  });
});

describe('on Glasgow revC3', () => {
  const have = hasFixture('glasgow-revC3');

  it.skipIf(!have)('lands the pins of every rotated and mirrored placement on the wires — the transform is right', () => {
    const text = fixtureText('glasgow-revC3/glasgow.kicad_sch');
    const targets = connectionPoints(text);
    const pins = placedPins(text);
    const hits = pins.filter(([x, y]) => targets.has(key(x, y))).length;
    // Measured 2026-09-22 over the eight rotation/mirror combinations the
    // root sheet uses: 354 of 389 with this transform (the rest are pins left
    // open on purpose), 327 with the mirror axis the other way round, and far
    // fewer without the y flip. The bound sits between the right answer and
    // the nearest wrong one.
    expect(pins.length).toBe(389);
    expect(hits).toBeGreaterThanOrEqual(350);
  });

  it.skipIf(!have)('draws each of the three sheets on A4 with its own count of parts', () => {
    const root = readSheetThumbnail(fixtureText('glasgow-revC3/glasgow.kicad_sch'))!;
    const banks = readSheetThumbnail(fixtureText('glasgow-revC3/io_banks.kicad_sch'))!;
    const buffer = readSheetThumbnail(fixtureText('glasgow-revC3/io_buffer.kicad_sch'))!;
    for (const t of [root, banks, buffer]) expect([t.width, t.height]).toEqual([297, 210]);
    expect(root.counts.symbols).toBe(170);
    expect(banks.counts.symbols).toBe(50);
    expect(buffer.counts.symbols).toBe(127);
    // io_buffer is placed from io_banks, not from the root: one box here.
    expect(root.counts.sheets).toBe(1);
    expect(root.counts.wires).toBe(379);
    // Path data, not a bitmap: a few tens of kilobytes at most per sheet.
    expect(root.symbols.length + root.wires.length).toBeLessThan(120_000);
  });
});
