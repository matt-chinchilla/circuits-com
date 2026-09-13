// frontend/src/public/services/kicad/schematicBom.test.ts
import { describe, expect, it } from 'vitest';
import { canPrice, MAX_REFS_PER_LINE } from '@public/services/bom/parseBom';
import { fixtureFiles, hasFixture, ROOT_UUID, SHEET_A_UUID, SHEET_B_UUID, schematic, sheet, symbol } from './fixtures';
import { buildProject } from './project';
import { readBomLines, readSchematic } from './schematicBom';

const f = (name: string, text: string) => new File([text], name);
const SUB_UUID = 'cccccccc-0000-4000-8000-000000000004';

async function lines(files: File[]) {
  return readSchematic(await buildProject(files));
}

describe('readSchematic — rules', () => {
  it('one line per instance path: a sheet placed twice yields two references (KiCad 7+ instances)', async () => {
    const sub = schematic({
      uuid: SUB_UUID,
      body: symbol({ lib: 'Device:R', uuid: 'r', ref: 'R201', value: '10k', footprint: 'R_0603', instances: [
        { path: `/${ROOT_UUID}/${SHEET_A_UUID}`, ref: 'R201' }, { path: `/${ROOT_UUID}/${SHEET_B_UUID}`, ref: 'R301' },
      ] }),
    });
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'amp.kicad_sch', name: 'A' })} ${sheet({ uuid: SHEET_B_UUID, file: 'amp.kicad_sch', name: 'B' })}` });
    const r = await lines([f('main.kicad_sch', root), f('amp.kicad_sch', sub)]);
    expect(r.instances).toBe(2);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 2, refs: ['R201', 'R301'], value: '10k', footprint: 'R_0603' });
    expect(r.refs.get('R301')).toEqual({ sheet: 'amp.kicad_sch', instancePath: `/${ROOT_UUID}/${SHEET_B_UUID}` });
  });

  it('reads KiCad 6 references from the root symbol_instances table, root-level and sub-sheet', async () => {
    const sub = schematic({ uuid: SUB_UUID, version: 20211123, body: symbol({ lib: 'Device:C', uuid: 'c-uuid', ref: 'C?', value: '100n' }) });
    const root = schematic({
      uuid: ROOT_UUID, version: 20211123,
      body: `${symbol({ lib: 'Device:R', uuid: 'r-uuid', ref: 'R?', value: '1k' })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub.kicad_sch' })}`,
      symbolInstances: `(symbol_instances (path "/r-uuid" (reference "R7") (unit 1) (value "1k") (footprint "")) (path "/${SHEET_A_UUID}/c-uuid" (reference "C9") (unit 1) (value "100n") (footprint "")))`,
    });
    const r = await lines([f('main.kicad_sch', root), f('sub.kicad_sch', sub)]);
    expect(r.result.lines.map((l) => l.refs)).toEqual([['R7'], ['C9']]);
  });

  it('falls back to the Reference property when no instance table names the symbol', async () => {
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R42', value: '4k7' }) }))]);
    expect(r.result.lines[0]!.refs).toEqual(['R42']);
  });

  it('skips in_bom no, #-references and (power) library symbols, and counts them', async () => {
    const body = [
      symbol({ lib: 'Device:R', uuid: 'a', ref: 'R1', value: '1k' }),
      symbol({ lib: 'Device:R', uuid: 'b', ref: 'R2', value: '1k', inBom: false }),
      symbol({ lib: 'power:GND', uuid: 'c', ref: '#PWR01', value: 'GND' }),
      symbol({ lib: 'power:+3V3', uuid: 'd', ref: 'PWR02', value: '+3V3' }),
      symbol({ lib: 'Mechanical:MountingHole', uuid: 'e', ref: 'H1', value: 'Hole' }),
    ].join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, libSymbols: '(symbol "power:+3V3" (power) (pin_names (offset 0)))', body }))]);
    expect(r.result.lines.map((l) => l.refs.join())).toEqual(['R1', 'H1']);
    expect(r.result.warnings.join('\n')).toMatch(/3 symbols skipped/);
  });

  it('dedupes multi-unit symbols on the reference designator', async () => {
    const body = `${symbol({ lib: 'Amplifier:LM358', uuid: 'u1a', ref: 'U1', value: 'LM358', unit: 1 })} ${symbol({ lib: 'Amplifier:LM358', uuid: 'u1b', ref: 'U1', value: 'LM358', unit: 2 })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 1, refs: ['U1'] });
  });

  // Glasgow revC3's U30 is a 5-unit FPGA drawn across two sheets (units 3+5 on
  // the root, 1, 2+4 on io_banks). It is ONE chip, so the dedupe cannot be
  // scoped to the instance path — that spelling buys the FPGA twice.
  it('dedupes a multi-unit symbol whose units are drawn on DIFFERENT sheets', async () => {
    const sub = schematic({
      uuid: SUB_UUID,
      body: symbol({ lib: 'Amplifier:LM358', uuid: 'u1b', ref: 'U1', value: 'LM358', unit: 2, instances: [{ path: `/${ROOT_UUID}/${SHEET_A_UUID}`, ref: 'U1', unit: 2 }] }),
    });
    const root = schematic({
      uuid: ROOT_UUID,
      body: `${symbol({ lib: 'Amplifier:LM358', uuid: 'u1a', ref: 'U1', value: 'LM358', unit: 1, instances: [{ path: `/${ROOT_UUID}`, ref: 'U1', unit: 1 }] })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub.kicad_sch' })}`,
    });
    const r = await lines([f('main.kicad_sch', root), f('sub.kicad_sch', sub)]);
    expect(r.instances).toBe(1);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 1, refs: ['U1'] });
  });

  it('carries dnp and routes user fields through the header aliases', async () => {
    const body = `${symbol({ lib: 'Device:C', uuid: 'a', ref: 'C1', value: '10u', dnp: true, extra: { MPN: 'GRM188R61A106KE69D', Manufacturer: 'Murata', Datasheet: 'https://x' } })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines[0]).toMatchObject({ dnp: true, mpn: 'GRM188R61A106KE69D', manufacturer: 'Murata' });
    expect(r.result.roleByColumn).toContain('mpn');
  });

  it('groups on (mpn, manufacturer, value, footprint, dnp) and sorts refs naturally', async () => {
    const body = ['R10', 'R2', 'R1'].map((ref, i) => symbol({ lib: 'Device:R', uuid: `r${i}`, ref, value: '1k', footprint: 'R_0603' })).join(' ') + symbol({ lib: 'Device:R', uuid: 'rx', ref: 'R3', value: '1k', footprint: 'R_0805' });
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines.map((l) => [l.qty, l.refs.join(',')])).toEqual([[3, 'R1,R2,R10'], [1, 'R3']]);
  });

  it('keeps qty as the true count when the designator list is capped, and says so', async () => {
    const body = Array.from({ length: 240 }, (_, i) => symbol({ lib: 'Device:C', uuid: `c${i}`, ref: `C${i + 1}`, value: '100n', footprint: 'C_0402' })).join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines[0]!.qty).toBe(240);
    expect(r.result.lines[0]!.refs).toHaveLength(MAX_REFS_PER_LINE);
    expect(r.result.warnings.join('\n')).toMatch(/240 instances.*first 200/);
  });

  it('is ready-mapped: the mapper never appears', async () => {
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) }))]);
    expect(canPrice(r.result.roleByColumn)).toBe(true);
    expect(r.result.headerSignature).toBe('kicad-sch');
    expect(r.result.unmappedColumns).toEqual([]);
    expect(r.result.headers).toHaveLength(r.result.roleByColumn.length);
  });

  it('hard-errors past MAX_LINES like the CSV path', async () => {
    const body = Array.from({ length: 2001 }, (_, i) => symbol({ lib: 'Device:R', uuid: `r${i}`, ref: `R${i}`, value: `${i}` })).join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.error).toMatch(/2,000/);
  });

  it('returns an error, not lines, for a project with no schematic', async () => {
    const r = readBomLines(await buildProject([f('b.kicad_pcb', '(kicad_pcb (version 20241229))')]));
    expect(r.error).toMatch(/no schematic/i);
    expect(r.lines).toEqual([]);
  });
});

describe('readSchematic — Glasgow revC3', () => {
  it('reads every reference once, with the twice-placed io_buffer doubled', async () => {
    const r = await lines(fixtureFiles('glasgow-revC3'));
    const refs = r.result.lines.flatMap((l) => l.refs);
    expect(new Set(refs).size).toBe(refs.length);
    expect(r.instances).toBeGreaterThan(100);
    // Pin the exact counts on first run and keep them: they are the regression fingerprint.
    expect({ lines: r.result.lines.length, instances: r.instances }).toMatchInlineSnapshot(`
      {
        "instances": 257,
        "lines": 70,
      }
    `);
    expect([...r.refs.values()].filter((l) => l.sheet === 'io_buffer.kicad_sch').map((l) => l.instancePath)).toHaveLength(r.instances - [...r.refs.values()].filter((l) => l.sheet !== 'io_buffer.kicad_sch').length);
  });
});

describe.skipIf(!hasFixture('kicad-demos'))('readSchematic — KiCad demo complex_hierarchy', () => {
  // Measured from the fixture: ampli_ht holds 46 symbols and is placed twice,
  // so it carries 92 instance references. 32 of those are power symbols, which
  // never reach a BOM, leaving 60; the LM358N dual op-amp draws both its units
  // on this sheet, so its two unit-symbols collapse to one part per placement
  // (U201, U301) and 60 becomes 58. 58 is the count of real purchasable parts
  // this sheet contributes, and it is the number the pricing tool must see.
  it('yields 58 BOM parts from the twice-placed 46-symbol sheet', async () => {
    const r = await lines(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    const ampRefs = [...r.refs.values()].filter((l) => l.sheet === 'complex_hierarchy/ampli_ht.kicad_sch');
    expect(ampRefs).toHaveLength(58);
  });
});
