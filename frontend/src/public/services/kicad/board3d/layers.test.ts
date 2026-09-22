import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { readBoardModel } from './readBoardModel';
import { zLadder } from './layers';

describe('zLadder', () => {
  it('Glasgow: four copper bands inside a 1.6 mm sandwich, thickness = the reader\'s listed sum', () => {
    const text = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
    const s = readStackup(text), m = readBoardModel(text, 0.05);
    const z = zLadder(m.layers, s);
    expect(z.warning).toBeNull();
    expect(z.thicknessMm).toBe(s.listedThicknessMm);
    const cu = z.layers.filter((l) => l.kind === 'copper');
    expect(cu.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(cu[3].z0).toBeCloseTo(0.01, 6);                  // above B.Mask (0.01)
    expect(cu[0].z1).toBeCloseTo(s.listedThicknessMm! - 0.01, 6);
    for (let i = 1; i < cu.length; i++) expect(cu[i].z1).toBeLessThan(cu[i - 1].z0);
  });
  it('the panel has no stackup: null thickness, a warning, and still a drawable ladder', () => {
    const text = fixtureText('bad-thing-panel/panel.kicad_pcb');
    const z = zLadder(readBoardModel(text, 0.05).layers, readStackup(text));
    expect(z.thicknessMm).toBeNull();
    expect(z.warning).toEqual({ kind: 'no-stackup' });
    expect(z.substrateTop).toBeGreaterThan(z.substrateBottom);
    expect(z.layers.filter((l) => l.kind === 'copper')).toHaveLength(2);
  });
  it('the nominal ladder fills the design thickness rather than adding to it', () => {
    const text = fixtureText('bad-thing-panel/panel.kicad_pcb');
    const z = zLadder(readBoardModel(text, 0.05).layers, readStackup(text));
    const cu = z.layers.filter((l) => l.kind === 'copper');
    expect(cu[0].z1).toBeCloseTo(1.6, 6);     // (general (thickness 1.6)) — drawn, never reported
    expect(cu[1].z0).toBe(0);
  });
  it('with no stackup and no design thickness it falls back to a nominal 1 mm', () => {
    const text = fixtureText('bad-thing-panel/panel.kicad_pcb');
    const z = zLadder(readBoardModel(text, 0.05).layers, null);
    const cu = z.layers.filter((l) => l.kind === 'copper');
    expect(z.thicknessMm).toBeNull();
    expect(cu[0].z1).toBeCloseTo(1, 6);
  });
});
