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

  // A dragged FOLDER arrives through file-selector: webkitRelativePath is empty
  // and the nested path rides on its own `.path` / `.relativePath`.
  const dragged = (path: string, content: BlobPart): File => {
    const file = f(path.slice(path.lastIndexOf('/') + 1), content);
    Object.defineProperty(file, 'path', { value: path });
    Object.defineProperty(file, 'relativePath', { value: path });
    return file;
  };
  const BACKUP_BOARD = '(kicad_pcb (version 20240108) (generator "pcbnew") (backup yes))';
  const LIVE_BOARD = '(kicad_pcb (version 20240108) (generator "pcbnew") (live yes))';
  const backupZip = (name: string) =>
    new File([zipSync({ 'main.kicad_pcb': strToU8(BACKUP_BOARD), 'main.kicad_sch': strToU8(ROOT), 'sub/reg.kicad_sch': strToU8(SUB) })], name);

  it('never opens a KiCad backup that arrives beside the live files with no path of its own', async () => {
    const p = await buildProject([
      f('main.kicad_sch', ROOT),
      f('sub/reg.kicad_sch', SUB),
      f('main.kicad_pcb', LIVE_BOARD),
      backupZip('main-2026-09-12_195300.zip'),
    ]);
    expect(p.files.get('main.kicad_pcb')).toBe(LIVE_BOARD);
    expect(p.warnings.join('\n')).not.toMatch(/dropped twice/);
  });

  it('never unpacks a zip inside a -backups/ folder of a dragged project folder', async () => {
    const p = await buildProject([
      dragged('/main/main.kicad_sch', ROOT),
      dragged('/main/sub/reg.kicad_sch', SUB),
      dragged('/main/main.kicad_pcb', LIVE_BOARD),
      Object.defineProperty(backupZip('x.zip'), 'path', { value: '/main/main-backups/x.zip' }),
    ]);
    expect(p.board).toBe('main/main.kicad_pcb');
    expect(p.files.get('main/main.kicad_pcb')).toBe(LIVE_BOARD);
    expect(p.warnings.join('\n')).not.toMatch(/dropped twice/);
  });

  it('keys a dragged folder by its relative path, so two same-named sheets stay two', async () => {
    const top = schematic({
      uuid: ROOT_UUID,
      body: `${sheet({ uuid: SHEET_A_UUID, file: 'a/reg.kicad_sch' })} ${sheet({ uuid: 'cccccccc-0000-4000-8000-000000000009', file: 'b/reg.kicad_sch' })}`,
    });
    const p = await buildProject([
      dragged('/proj/top.kicad_sch', top),
      dragged('/proj/a/reg.kicad_sch', SUB),
      dragged('/proj/b/reg.kicad_sch', SUB),
    ]);
    expect(p.sheets.map((s) => s.path)).toEqual(['proj/top.kicad_sch', 'proj/a/reg.kicad_sch', 'proj/b/reg.kicad_sch']);
    expect(p.warnings.join('\n')).not.toMatch(/dropped twice/);
  });

  it('a chosen file keeps its plain name (file-selector stamps "./name" on a picked file)', async () => {
    const picked = f('main.kicad_sch', ROOT);
    Object.defineProperty(picked, 'path', { value: './main.kicad_sch' });
    const p = await buildProject([picked, f('sub/reg.kicad_sch', SUB)]);
    expect(p.root).toBe('main.kicad_sch');
  });

  it('many backups never count toward the file cap', async () => {
    const backups = Array.from({ length: 12 }, (_, i) => backupZip(`main-2026-09-${String(10 + i).padStart(2, '0')}_195300.zip`));
    const p = await buildProject([f('main.kicad_sch', ROOT), f('sub/reg.kicad_sch', SUB), f('main.kicad_pcb', LIVE_BOARD), ...backups]);
    expect(p.files.get('main.kicad_pcb')).toBe(LIVE_BOARD);
  });

  it('still opens ONE backup zip dropped on its own, on purpose', async () => {
    const p = await buildProject([backupZip('main-2026-09-12_195300.zip')]);
    expect(p.files.get('main.kicad_pcb')).toBe(BACKUP_BOARD);
  });

  it('never lets an autosave copy take the board slot', async () => {
    const zip = new File(
      [zipSync({ 'g/g.kicad_sch': strToU8(ROOT), 'g/sub/reg.kicad_sch': strToU8(SUB), 'g/g.kicad_pcb': strToU8(LIVE_BOARD), 'g/_autosave-g.kicad_pcb': strToU8(BACKUP_BOARD) })],
      'g.zip',
    );
    const p = await buildProject([zip]);
    expect(p.board).toBe('g/g.kicad_pcb');
    expect(p.warnings.join('\n')).not.toMatch(/boards were dropped/);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad demo with a twice-placed sheet', async () => {
    const p = await buildProject(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    expect(p.sheets.map((s) => s.path)).toEqual(['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch']);
  });
});
