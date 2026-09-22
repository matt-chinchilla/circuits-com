import { describe, expect, it } from 'vitest';
import { fixtureText } from './fixtures';
import { readPlacements } from './boardPlacements';
import { KicadReadError } from './types';

describe('readPlacements', () => {
  it('reads every placed footprint of Glasgow with the file’s own numbers', () => {
    const placed = readPlacements(fixtureText('glasgow-revC3/glasgow.kicad_pcb'));
    // 272 footprints, but seven of them — the logos and the kikit tabs — are all
    // annotated `REF**`, and a map keyed by reference keeps the first of those.
    expect(placed.size).toBe(266);
    expect(placed.has('REF**')).toBe(true);
    // (footprint "…BGA…" (layer "F.Cu") … (at 83.7 95.5 -90) … (fp_text reference "U30" …)
    const u30 = placed.get('U30')!;
    expect(u30).toMatchObject({ ref: 'U30', side: 'F', x: 83.7, y: 95.5, rotDeg: -90 });
    expect(u30.lib).toMatch(/BGA/);
    expect(u30.value).toBe('ICE40HX8K-BG121');
    // (footprint "Glasgow:Molex_KK-254_1x02_P2.54mm_Horizontal" locked (layer "F.Cu") … (at 84.1 108.4)
    expect(placed.get('J4')).toMatchObject({ side: 'F', x: 84.1, y: 108.4, rotDeg: 0, lib: 'Glasgow:Molex_KK-254_1x02_P2.54mm_Horizontal' });
    // A back-side part is reported as such.
    expect([...placed.values()].some((p) => p.side === 'B')).toBe(true);
  });

  it('is cheap enough to run on the main thread once per project', () => {
    const text = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
    const t0 = performance.now();
    readPlacements(text);
    // Loose: a CI box is slower than a laptop. Measured 39-52 ms here (node,
    // five runs); the point is that it is not the whole 3D build (~800 ms).
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it('reads the KiCad 7+ spelling and leaves out a footprint with no position', () => {
    const text = `(kicad_pcb (version 20231120)
      (footprint "R_0402" (layer "B.Cu") (at 10 20 45) (property "Reference" "R1") (property "Value" "10k"))
      (footprint "Logo" (layer "F.Cu") (property "Reference" "G1"))
      (footprint "R_0402" (layer "F.Cu") (at 1 2) (property "Reference" "R1") (property "Value" "dup"))
    )`;
    const placed = readPlacements(text);
    expect(placed.get('R1')).toEqual({ ref: 'R1', lib: 'R_0402', value: '10k', side: 'B', x: 10, y: 20, rotDeg: 45 });
    expect(placed.has('G1')).toBe(false);
    expect(placed.size).toBe(1);
  });

  it('refuses a file that is not a board, on readStackup’s terms', () => {
    expect(() => readPlacements('(kicad_sch (version 1))')).toThrow(KicadReadError);
    expect(() => readPlacements('(kicad_pcb (version 1) (footprint "x"')).toThrow(KicadReadError);
  });
});
