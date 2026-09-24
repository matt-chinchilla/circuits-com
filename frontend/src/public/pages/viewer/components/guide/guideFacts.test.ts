/**
 * The facts the guide draws, checked against the code and the files that make
 * them true: every role the folder labels is what the reader resolves, every
 * "left out" row really is left out by the reader's filter, and the turned-away examples
 * are what the reader really says for those drops.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { INTAKE_MESSAGES, buildProject } from '@public/services/kicad/project';
import { KICAD5_MESSAGE, KicadReadError } from '@public/services/kicad/types';
import { isIgnoredPath, isKicadName } from '@public/services/kicad/zip';
import { pickMisses } from '@public/services/bom/useBomWorkbench';
import type { TableRow } from '@public/services/bom/types';
import { EXAMPLE_URL } from '../../intakeCopy';
import { EXAMPLE_FILES, EXAMPLE_FOLDER, LEFT_OUT, REFUSALS } from './guideCopy';

const PUBLIC = join(__dirname, '../../../../../../public');

async function refusalOf(files: File[]): Promise<string> {
  try {
    await buildProject(files);
  } catch (err) {
    if (err instanceof KicadReadError) return err.message;
    throw err;
  }
  throw new Error('the drop was not refused');
}

/** Minimal files the real reader accepts, named as the sheet names them: the
 *  root sheet places every sub-sheet (KiCad's `Sheetfile` property), so the
 *  reader has to FIND the hierarchy from the names, not be told it. */
function listedProject(): { path: string; text: string }[] {
  const subs = EXAMPLE_FILES.filter((f) => f.role === 'sub-sheet').map((f) => f.name);
  return EXAMPLE_FILES.map((f) => {
    const path = `${EXAMPLE_FOLDER}${f.name}`;
    if (f.net === 'pro') return { path, text: JSON.stringify({ meta: { filename: f.name }, sheets: [] }) };
    if (f.net === 'pcb') return { path, text: '(kicad_pcb (version 20240108) (generator "pcbnew"))' };
    const placed = f.role === 'root sheet' ? subs.map((s) => `(sheet (property "Sheetfile" "${s}"))`).join(' ') : '';
    return { path, text: `(kicad_sch (version 20231120) (generator "eeschema") ${placed})` };
  });
}

describe('the folder on the sheet', () => {
  it('names a generic project, never the example it stands beside', () => {
    const shown = [EXAMPLE_FOLDER, ...EXAMPLE_FILES.map((f) => f.name), ...LEFT_OUT.map((f) => f.name), ...REFUSALS.map((r) => r.message)];
    for (const text of shown) expect(text, text).not.toMatch(/glasgow|io_banks|io_buffer/i);
  });

  it('lists only files the reader reads, each on the net its extension feeds', () => {
    const netOf = { '.kicad_pro': 'pro', '.kicad_sch': 'sch', '.kicad_pcb': 'pcb' } as const;
    for (const f of EXAMPLE_FILES) {
      const path = `${EXAMPLE_FOLDER}${f.name}`;
      expect(isKicadName(path) && !isIgnoredPath(path), path).toBe(true);
      expect(netOf[f.name.slice(f.name.lastIndexOf('.')) as keyof typeof netOf], f.name).toBe(f.net);
    }
  });

  it('labels every role the way the real reader resolves it', async () => {
    const project = await buildProject(listedProject().map(({ path, text }) => new File([text], path)));
    const by = (role: string) => EXAMPLE_FILES.filter((f) => f.role === role).map((f) => `${EXAMPLE_FOLDER}${f.name}`);
    expect(project.warnings).toEqual([]);
    expect(project.missingSheets).toEqual([]);
    expect(`${project.name}/`).toBe(EXAMPLE_FOLDER);
    expect(project.pro).not.toBeNull();
    expect(by('project')).toHaveLength(1);
    expect([project.root]).toEqual(by('root sheet'));
    expect(project.sheets.slice(1).map((s) => s.path).sort()).toEqual(by('sub-sheet').sort());
    expect([project.board]).toEqual(by('board'));
  });

  it('has the same shape as the example project the button loads', () => {
    const entries = Object.keys(unzipSync(new Uint8Array(readFileSync(join(PUBLIC, EXAMPLE_URL)))));
    const read = entries.filter((e) => isKicadName(e) && !isIgnoredPath(e));
    const count = (names: string[], ext: string) => names.filter((n) => n.endsWith(ext)).length;
    for (const ext of ['.kicad_pro', '.kicad_sch', '.kicad_pcb']) {
      expect(count(EXAMPLE_FILES.map((f) => f.name), ext), ext).toBe(count(read, ext));
    }
  });

  it('marks as "left out" only what the reader really never reads', () => {
    for (const row of LEFT_OUT) {
      expect(row.probe.startsWith(EXAMPLE_FOLDER), row.probe).toBe(true);
      expect(isIgnoredPath(row.probe) || !isKicadName(row.probe), row.probe).toBe(true);
    }
  });

  it('left-out rows name what the reader actually skips, and nothing it would read', async () => {
    const leftOut = LEFT_OUT.map((r) => new File(['(kicad_pcb (version 20240108) (left-out yes))'], r.probe));
    const project = await buildProject([...listedProject().map(({ path, text }) => new File([text], path)), ...leftOut]);
    expect([...project.files.keys()].sort()).toEqual(EXAMPLE_FILES.map((f) => `${EXAMPLE_FOLDER}${f.name}`).sort());
  });

  // The sheet draws a FOLDER, so the listing must also hold for the files a
  // folder drag delivers: a nested path on file-selector's `.path`, or no path
  // at all — a backup zip then arrives by its bare timestamped name.
  it('keeps the backups left out when the folder itself is dragged in, with or without its paths', async () => {
    const live = listedProject();
    const board = live.find(({ path }) => path.endsWith('.kicad_pcb'))!;
    const { zipSync, strToU8 } = await import('fflate');
    const backupName = LEFT_OUT.find((r) => r.folder && r.probe.includes('-backups/'))!.probe;
    const backup = zipSync({ [board.path.slice(board.path.lastIndexOf('/') + 1)]: strToU8('(kicad_pcb (version 20240108) (backup yes))') });
    for (const withPaths of [false, true]) {
      const asDropped = (path: string, data: BlobPart) => {
        const file = new File([data], path.slice(path.lastIndexOf('/') + 1));
        if (withPaths) Object.defineProperty(file, 'path', { value: `/${path}` });
        return file;
      };
      const project = await buildProject([...live.map(({ path, text }) => asDropped(path, text)), asDropped(backupName, backup as BlobPart)]);
      const shown = project.files.get(project.board!)!;
      expect(shown, `paths: ${withPaths}`).not.toContain('(backup yes)');
      expect(project.warnings.join('\n'), `paths: ${withPaths}`).not.toMatch(/dropped twice/);
    }
  });
});

describe('the turned-away examples', () => {
  it('are what the reader says for those drops', async () => {
    const byWhat = Object.fromEntries(REFUSALS.map((r) => [r.what, r.message]));
    // A zip of fab outputs: nothing KiCad inside, so nothing is unpacked.
    const { zipSync } = await import('fflate');
    const gerbers = zipSync({ [LEFT_OUT.find((r) => r.name === 'gerbers/')!.probe]: new Uint8Array([71, 48, 52]) });
    expect(await refusalOf([new File([gerbers], 'gerbers.zip')])).toBe(byWhat['A zip of Gerbers or other outputs']);
    expect(byWhat['A zip of Gerbers or other outputs']).toBe(INTAKE_MESSAGES.empty);
    // A KiCad 5 project, by its names.
    expect(await refusalOf([new File(['EESchema'], 'old.sch'), new File(['x'], 'old.pro')])).toBe(KICAD5_MESSAGE);
  });

  it('turn away a KiCad 5 PROJECT, not its files: beside a re-saved board they are skipped (note 2 says so)', async () => {
    const project = await buildProject([
      new File(['EESchema'], 'my-board.sch'),
      new File(['x'], 'my-board.pro'),
      new File(['(kicad_pcb (version 20240108) (generator "pcbnew"))'], 'my-board.kicad_pcb'),
    ]);
    expect(project.board).toMatch(/my-board\.kicad_pcb$/);
    expect(project.warnings.join('\n')).not.toContain(KICAD5_MESSAGE);
  });
});

describe('what the live lookup sends', () => {
  it('is a line index, the part number and a query the server built — no quantities, no designators', () => {
    const row = {
      index: 4,
      mpn: 'RC0402FR-0710KL',
      qty: 12,
      refs: ['R1', 'R2'],
      dnp: false,
      server: { status: 'resolve', resolve_query: '10k 0402' },
    } as unknown as TableRow;
    const { misses } = pickMisses([row], false);
    expect(Object.keys(misses[0]!).sort()).toEqual(['index', 'mpn', 'query']);
  });
});
