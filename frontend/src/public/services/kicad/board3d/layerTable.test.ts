import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { KicadReadError } from '../types';
import { readBoardModel } from './readBoardModel';
import { readLayerTable, readNetTable } from './layerTable';

const FIXTURES = {
  glasgow: 'glasgow-revC3/glasgow.kicad_pcb',
  stickhub: 'kicad-demos/stickhub/StickHub.kicad_pcb',
  hier: 'kicad-demos/complex_hierarchy/complex_hierarchy.kicad_pcb',
  panel: 'bad-thing-panel/panel.kicad_pcb',
} as const;

/** The net table counted WITHOUT the reader: every depth-1 `(net N "…")` row
 *  (two-space or tab indented, as KiCad 6 and 9 write it), less net 0. */
function tableRows(text: string): number {
  return [...text.matchAll(/^(?: {2}|\t)\(net (\d+) "/gm)].filter((m) => m[1] !== '0').length;
}

describe('readLayerTable', () => {
  it('Glasgow (KiCad 6): 18 rows in file order, four copper layers', () => {
    const layers = readLayerTable(fixtureText(FIXTURES.glasgow));
    expect(layers).toHaveLength(18);
    expect(layers.map((l) => l.name).slice(0, 4)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(layers.filter((l) => l.kind === 'copper').map((l) => l.side)).toEqual(['F', 'In', 'In', 'B']);
    expect(layers.find((l) => l.name === 'B.SilkS')).toEqual({ ordinal: 36, name: 'B.SilkS', kind: 'silk', side: 'B' });
    expect(layers.at(-1)).toEqual({ ordinal: 49, name: 'F.Fab', kind: 'other', side: 'F' });
  });
  it('StickHub and complex_hierarchy (KiCad 9 ordinals): 20 rows, two copper layers', () => {
    for (const rel of [FIXTURES.stickhub, FIXTURES.hier]) {
      const layers = readLayerTable(fixtureText(rel));
      expect(layers, rel).toHaveLength(20);
      expect(layers.filter((l) => l.kind === 'copper')).toEqual([
        { ordinal: 0, name: 'F.Cu', kind: 'copper', side: 'F' },
        { ordinal: 2, name: 'B.Cu', kind: 'copper', side: 'B' },
      ]);
      expect(layers.find((l) => l.name === 'F.Mask')).toEqual({ ordinal: 1, name: 'F.Mask', kind: 'mask', side: 'F' });
      expect(layers.find((l) => l.name === 'Edge.Cuts')?.kind).toBe('edge');
    }
  });
  it('the panel: 29 rows, the nine User.N layers last', () => {
    const layers = readLayerTable(fixtureText(FIXTURES.panel));
    expect(layers).toHaveLength(29);
    expect(layers.slice(-9).map((l) => l.name)).toEqual(Array.from({ length: 9 }, (_, i) => `User.${i + 1}`));
  });
  it('is exactly the table the full reader builds, on every fixture', () => {
    for (const rel of Object.values(FIXTURES)) {
      const text = fixtureText(rel);
      expect(readLayerTable(text), rel).toEqual(readBoardModel(text, 0.05).layers);
    }
  });
  it('refuses a file that is not a board, and a table past KiCad’s ceilings', () => {
    expect(() => readLayerTable('(kicad_sch (version 1))')).toThrow(KicadReadError);
    const rows = Array.from({ length: 40 }, (_, i) => `(${i} "In${i}.Cu" signal)`).join(' ');
    expect(() => readLayerTable(`(kicad_pcb (version 1) (layers ${rows}))`)).toThrow(/copper layers/);
  });
  it('a board with no (layers …) block has no layers', () => {
    expect(readLayerTable('(kicad_pcb (version 20221018))')).toEqual([]);
  });
});

describe('readNetTable', () => {
  it('Glasgow: every row of the table but net 0, ascending, names as written', () => {
    const text = fixtureText(FIXTURES.glasgow);
    const nets = readNetTable(text);
    expect(nets).toHaveLength(251);
    expect(nets).toHaveLength(tableRows(text));
    expect(nets[0]).toEqual({ number: 1, name: '/SDA' });
    expect(nets.at(-1)).toEqual({ number: 251, name: 'unconnected-(U30-PadB10)' });
    expect(nets.find((n) => n.name === 'GND')).toEqual({ number: 3, name: 'GND' });
  });
  it('the other three fixtures: the table’s own row counts', () => {
    const counts: Record<string, number> = { stickhub: 47, hier: 52, panel: 1 };
    for (const [key, n] of Object.entries(counts)) {
      const text = fixtureText(FIXTURES[key as keyof typeof FIXTURES]);
      expect(readNetTable(text), key).toHaveLength(n);
      expect(tableRows(text), key).toBe(n);
    }
    expect(readNetTable(fixtureText(FIXTURES.panel))).toEqual([{ number: 1, name: 'GNDREF' }]);
  });
  it('is exactly the table the full reader builds, on every fixture', () => {
    for (const rel of Object.values(FIXTURES)) {
      const text = fixtureText(rel);
      expect(readNetTable(text), rel).toEqual(readBoardModel(text, 0.05).nets);
    }
  });
  it('a board with no net table has no nets', () => {
    expect(readNetTable('(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal)))')).toEqual([]);
  });
});
