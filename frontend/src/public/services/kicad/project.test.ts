import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fixtureFiles, fixtureText, hasFixture, ROOT_UUID, SHEET_A_UUID, schematic, sheet, symbol } from './fixtures';
import { buildProject, resolveSheetRef, versionOf } from './project';
import { INTAKE_CAPS } from './types';

const f = (name: string, content: BlobPart) => new File([content], name);
const ROOT = schematic({ uuid: ROOT_UUID, body: `${symbol({ lib: 'Device:R', uuid: 's1', ref: 'R1', value: '10k' })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub/reg.kicad_sch' })}` });
const SUB = schematic({ uuid: 'cccccccc-0000-4000-8000-000000000004', body: symbol({ lib: 'Device:C', uuid: 's2', ref: 'C1', value: '100n' }) });

describe('versionOf', () => {
  it('reads the version token off a schematic and a board head', () => {
    expect(versionOf('(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")')).toBe(20250114);
    expect(versionOf('(kicad_pcb (version 20211014) (generator pcbnew)')).toBe(20211014);
    expect(versionOf('EESchema Schematic File Version 2')).toBeNull();
  });
});

describe('resolveSheetRef', () => {
  const known = ['main.kicad_sch', 'power/reg.kicad_sch', 'analog/reg.kicad_sch', 'power/lib/x.kicad_sch'];
  it('resolves relative to the referencing sheet first', () => {
    expect(resolveSheetRef('power/top.kicad_sch', 'reg.kicad_sch', known)).toEqual({ path: 'power/reg.kicad_sch', byName: false });
    expect(resolveSheetRef('power/top.kicad_sch', 'lib/x.kicad_sch', known)).toEqual({ path: 'power/lib/x.kicad_sch', byName: false });
    expect(resolveSheetRef('main.kicad_sch', './power/reg.kicad_sch', known)).toEqual({ path: 'power/reg.kicad_sch', byName: false });
  });
  it('falls back to a unique basename, and reports an ambiguous one as missing', () => {
    expect(resolveSheetRef('main.kicad_sch', 'x.kicad_sch', known)).toEqual({ path: 'power/lib/x.kicad_sch', byName: true });
    expect(resolveSheetRef('main.kicad_sch', 'reg.kicad_sch', known)).toEqual({ missing: true, candidates: ['analog/reg.kicad_sch', 'power/reg.kicad_sch'] });
    expect(resolveSheetRef('main.kicad_sch', 'nope.kicad_sch', known)).toEqual({ missing: true, candidates: [] });
  });
  it('never resolves traversal', () => {
    expect(resolveSheetRef('power/top.kicad_sch', '../main.kicad_sch', known)).toEqual({ missing: true, candidates: [] });
  });
});

describe('buildProject', () => {
  it('builds a hierarchical project from loose files, root first, keyed by path', async () => {
    const p = await buildProject([f('sub/reg.kicad_sch', SUB), f('main.kicad_sch', ROOT), f('main.kicad_pro', '{"sheets":[["' + ROOT_UUID + '","Root"]],"meta":{"filename":"main.kicad_pro"}}')]);
    expect(p.name).toBe('main');
    expect(p.root).toBe('main.kicad_sch');
    expect(p.sheets.map((s) => s.path)).toEqual(['main.kicad_sch', 'sub/reg.kicad_sch']);
    expect(p.sheets[0]!.uuid).toBe(ROOT_UUID);
    expect(p.pro?.sheets).toEqual([[ROOT_UUID, 'Root']]);
    expect(p.board).toBeNull();
    expect(p.missingSheets).toEqual([]);
    expect(p.formatVersions['main.kicad_sch']).toBe(20250114);
  });

  it('keeps two same-named sheets in different directories apart', async () => {
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'power/reg.kicad_sch' })} ${sheet({ uuid: 'bbbbbbbb-0000-4000-8000-000000000003', file: 'analog/reg.kicad_sch' })}` });
    const p = await buildProject([f('main.kicad_sch', root), f('power/reg.kicad_sch', SUB), f('analog/reg.kicad_sch', SUB.replace('C1', 'C2'))]);
    expect(p.sheets.map((s) => s.path)).toEqual(['main.kicad_sch', 'power/reg.kicad_sch', 'analog/reg.kicad_sch']);
    expect(p.files.size).toBe(3);
  });

  it('names missing sheets and warns on an ambiguous one', async () => {
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'reg.kicad_sch' })} ${sheet({ uuid: 'bbbbbbbb-0000-4000-8000-000000000003', file: 'gone.kicad_sch' })}` });
    const p = await buildProject([f('main.kicad_sch', root), f('a/reg.kicad_sch', SUB), f('b/reg.kicad_sch', SUB)]);
    expect(p.missingSheets).toEqual(['reg.kicad_sch', 'gone.kicad_sch']);
    expect(p.warnings.join('\n')).toMatch(/reg\.kicad_sch.*a\/reg\.kicad_sch.*b\/reg\.kicad_sch/s);
  });

  it('picks the root by project stem, else by "not referenced", else first', async () => {
    const byStem = await buildProject([f('other.kicad_sch', SUB), f('x.kicad_sch', ROOT), f('x.kicad_pro', '{}')]);
    expect(byStem.root).toBe('x.kicad_sch');
    const byRef = await buildProject([f('sub/reg.kicad_sch', SUB), f('top.kicad_sch', ROOT)]);
    expect(byRef.root).toBe('top.kicad_sch');
    const first = await buildProject([f('b.kicad_sch', SUB), f('a.kicad_sch', SUB)]);
    expect(first.root).toBe('b.kicad_sch');
  });

  it('accepts a zip and ignores what the tool does not read', async () => {
    const zip = new File([zipSync({ 'proj/main.kicad_sch': strToU8(ROOT), 'proj/sub/reg.kicad_sch': strToU8(SUB), 'proj/main.kicad_pcb': strToU8('(kicad_pcb (version 20241229) (generator "pcbnew"))'), 'proj/main.kicad_prl': strToU8('{}'), 'proj/3d/x.step': strToU8('solid') })], 'proj.zip');
    const p = await buildProject([zip]);
    expect([...p.files.keys()].sort()).toEqual(['proj/main.kicad_pcb', 'proj/main.kicad_sch', 'proj/sub/reg.kicad_sch']);
    expect(p.board).toBe('proj/main.kicad_pcb');
  });

  it('refuses KiCad 5 by name and by board version, before anything else', async () => {
    await expect(buildProject([f('old.sch', fixtureText('kicad5-header.sch')), f('old.pro', 'update=x')])).rejects.toMatchObject({ kind: 'kicad5' });
    await expect(buildProject([f('b.kicad_pcb', '(kicad_pcb (version 20171130) (host pcbnew 5.1))')])).rejects.toMatchObject({ kind: 'kicad5' });
  });

  it('errors on nothing to read, and on each intake cap after the filter', async () => {
    await expect(buildProject([f('notes.txt', 'hi')])).rejects.toMatchObject({ kind: 'empty' });
    const many = Array.from({ length: INTAKE_CAPS.files + 1 }, (_, i) => f(`s${i}.kicad_sch`, SUB));
    await expect(buildProject(many)).rejects.toMatchObject({ kind: 'cap' });
    await expect(buildProject([f('huge.kicad_pcb', new Uint8Array(INTAKE_CAPS.perFileBytes + 1))])).rejects.toMatchObject({ kind: 'cap' });
  });

  it('refuses a project file with nothing to show', async () => {
    await expect(buildProject([f('only.kicad_pro', '{}')])).rejects.toMatchObject({ kind: 'empty' });
  });

  it('reads Glasgow revC3: root, two sub-sheets, a board, no missing sheets', async () => {
    const p = await buildProject(fixtureFiles('glasgow-revC3'));
    expect(p.name).toBe('glasgow');
    expect(p.root).toBe('glasgow.kicad_sch');
    expect(p.sheets.map((s) => s.path)).toEqual(['glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch']);
    expect(p.board).toBe('glasgow.kicad_pcb');
    expect(p.missingSheets).toEqual([]);
    expect(p.pro?.sheets.length).toBe(4);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad demo with a twice-placed sheet', async () => {
    const p = await buildProject(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    expect(p.sheets.map((s) => s.path)).toEqual(['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch']);
  });
});
