// frontend/src/public/services/kicad/boardStackup.test.ts
import { describe, expect, it } from 'vitest';
import { readStackup } from './boardStackup';
import { fixtureText, hasFixture } from './fixtures';
import { KicadReadError } from './types';

const LAYERS_9 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" power) (6 "In2.Cu" mixed) (2 "B.Cu" jumper) (9 "F.Adhes" user "F.Adhesive") (11 "F.Paste" user) (13 "F.SilkS" user "F.Silkscreen") (15 "F.Mask" user) (25 "Edge.Cuts" user))';
const LAYERS_8 = '(layers (0 "F.Cu" signal) (1 "In1.Cu" power) (2 "In2.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user "B.Adhesive"))';
const STACKUP = '(setup (stackup (layer "F.SilkS" (type "Top Silk Screen") (color "White")) (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01)) (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02)) (layer "In1.Cu" (type "copper") (thickness 0.018)) (layer "dielectric 2" (type "core") (thickness 0.84) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02)) (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)) (copper_finish "ENIG") (dielectric_constraints no)) (pad_to_mask_clearance 0))';
const VIAS = '(via (at 1 1) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)) (via locked (at 2 2) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu")) (via blind (at 3 3) (size 0.4) (drill 0.2) (layers "F.Cu" "In1.Cu")) (via micro (at 4 4) (layers "F.Cu" "In1.Cu")) (via micro locked (at 5 5) (layers "In1.Cu" "In2.Cu")) (via blind (at 6 6) (layers "In1.Cu" "In2.Cu")) (via weird (at 7 7) (layers "F.Cu" "B.Cu"))';
const board = (parts: string) => `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6) (legacy_teardrops no)) ${parts})`;

describe('readStackup', () => {
  it('selects copper rows by name, in file order, with the kind mapped, under both id schemes', () => {
    const nine = readStackup(board(LAYERS_9));
    expect(nine.copperLayers).toEqual([
      { ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Plane' },
      { ordinal: 3, name: 'In2.Cu', kind: 'Mixed' }, { ordinal: 4, name: 'B.Cu', kind: 'Jumper' },
    ]);
    expect(nine.layerCount).toBe(4);
    const eight = readStackup(board(LAYERS_8));
    expect(eight.copperLayers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  });

  it('returns stackup null when the block is absent, and the design thickness separately', () => {
    const s = readStackup(board(LAYERS_9));
    expect(s.stackup).toBeNull();
    expect(s.listedThicknessMm).toBeNull();
    expect(s.designThicknessMm).toBe(1.6);
    expect(s.copperFinish).toBeNull();
  });

  it('reads the physical stackup rows in file order with the listed thickness summed', () => {
    const s = readStackup(board(`${LAYERS_9} ${STACKUP}`));
    expect(s.stackup?.map((r) => r.name)).toEqual(['F.SilkS', 'F.Mask', 'F.Cu', 'dielectric 1', 'In1.Cu', 'dielectric 2', 'B.Cu', 'B.Mask']);
    expect(s.stackup?.[3]).toEqual({ name: 'dielectric 1', type: 'prepreg', thicknessMm: 0.1, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 });
    expect(s.stackup?.[0]?.thicknessMm).toBeNull();
    expect(s.listedThicknessMm).toBeCloseTo(0.01 + 0.035 + 0.1 + 0.018 + 0.84 + 0.035 + 0.01, 6);
    expect(s.copperFinish).toBe('ENIG');
  });

  it('groups vias by (type, start, end); locked is a flag; unknown tokens are unknown', () => {
    const s = readStackup(board(`${LAYERS_9} ${VIAS}`));
    expect(s.vias).toEqual([
      { type: 'through', start: 'F.Cu', end: 'B.Cu', count: 2 },
      { type: 'blind', start: 'F.Cu', end: 'In1.Cu', count: 1 },
      { type: 'micro', start: 'F.Cu', end: 'In1.Cu', count: 1 },
      { type: 'micro', start: 'In1.Cu', end: 'In2.Cu', count: 1 },
      { type: 'blind', start: 'In1.Cu', end: 'In2.Cu', count: 1 },
      { type: 'unknown', start: 'F.Cu', end: 'B.Cu', count: 1 },
    ]);
  });

  it('never materializes the tracks: a board at the 8 MB cap with 90k segments reads in under two seconds', () => {
    const segments = Array.from({ length: 90_000 }, (_, i) => `(segment (start ${i} 0) (end ${i} 1) (width 0.2) (layer "F.Cu") (net 1) (uuid "s${i}"))`).join('\n');
    const text = board(`${LAYERS_9} ${STACKUP} ${VIAS}\n${segments}`);
    expect(text.length).toBeGreaterThan(7 * 1024 * 1024);
    const t0 = performance.now();
    const s = readStackup(text);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.vias.reduce((n, g) => n + g.count, 0)).toBe(7);
  });

  // DEVIATION from the task brief, which expected 410 plain + 7 locked = 417.
  // The committed fixture holds 409 plain + 7 locked = 416 top-level (via …)
  // blocks, every one of them spanning "F.Cu" "B.Cu". Measured over the file
  // with the same depth-2 walk topLevelBlocks uses; the naive
  // `grep -c '(via'` reads 418 because it also counts the `(vias` keepout row
  // and `(viasonmask`, which is where an off-by-one on this number comes from.
  it('reads Glasgow revC3: four copper layers, a stackup, 409 through + 7 locked-through vias', () => {
    const s = readStackup(fixtureText('glasgow-revC3/glasgow.kicad_pcb'));
    expect(s.copperLayers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(s.stackup).not.toBeNull();
    expect(s.vias.filter((g) => g.type === 'through').reduce((n, g) => n + g.count, 0)).toBe(416);
    expect(s.vias.some((g) => g.type === 'unknown')).toBe(false);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad 10 StickHub board (version 20250907) with no unknown via', () => {
    const s = readStackup(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'));
    expect(s.vias.reduce((n, g) => n + g.count, 0)).toBe(87);
    expect(s.stackup?.some((r) => r.type === 'core')).toBe(true);
  });

  // Carry-forward from Task 1.5: buildProject accepts a .kicad_pcb with no
  // (version …), so a mis-typed file can reach this reader. An empty structure
  // would render as "a board with nothing on it"; the typed error is the truth.
  it('throws unreadable rather than returning an empty structure when the text is not a board', () => {
    const thrown = ((): unknown => {
      try {
        readStackup('(kicad_sch (version 20250114) (uuid "abc") (paper "A4"))');
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(KicadReadError);
    expect((thrown as KicadReadError).kind).toBe('unreadable');
  });
});
