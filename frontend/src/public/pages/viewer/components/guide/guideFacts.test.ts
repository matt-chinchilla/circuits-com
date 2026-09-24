/**
 * The facts the guide draws, checked against the code and the files that make
 * them true: the example folder IS the committed example zip, every "left out"
 * row really is left out by the reader's filter, and the turned-away examples
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
import { EXAMPLE_FILES, LEFT_OUT, REFUSALS } from './guideCopy';

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

describe('the folder on the sheet', () => {
  it('lists exactly the KiCad files the example zip holds', () => {
    const entries = Object.keys(unzipSync(new Uint8Array(readFileSync(join(PUBLIC, EXAMPLE_URL)))));
    const read = entries.filter((e) => isKicadName(e) && !isIgnoredPath(e)).sort();
    expect(EXAMPLE_FILES.map((f) => f.name).sort()).toEqual(read);
  });

  it('marks as "left out" only what the reader really never reads', () => {
    for (const row of LEFT_OUT) expect(isIgnoredPath(row.probe) || !isKicadName(row.probe), row.probe).toBe(true);
  });

  // The sheet draws a FOLDER, so the listing must also hold for the files a
  // folder drag delivers: a nested path on file-selector's `.path`, or no path
  // at all — a backup zip then arrives by its bare timestamped name.
  it('keeps the backups left out when the folder itself is dragged in, with or without its paths', async () => {
    const example = unzipSync(new Uint8Array(readFileSync(join(PUBLIC, EXAMPLE_URL))));
    const live = Object.entries(example).filter(([name]) => isKicadName(name) && !isIgnoredPath(name));
    const board = live.find(([name]) => name.endsWith('.kicad_pcb'))!;
    const { zipSync, strToU8 } = await import('fflate');
    const backupName = LEFT_OUT.find((r) => r.folder && r.probe.includes('-backups/'))!.probe;
    const backup = zipSync({ [board[0].slice(board[0].lastIndexOf('/') + 1)]: strToU8('(kicad_pcb (version 20240108) (backup yes))') });
    for (const withPaths of [false, true]) {
      const asDropped = (path: string, data: BlobPart) => {
        const file = new File([data], path.slice(path.lastIndexOf('/') + 1));
        if (withPaths) Object.defineProperty(file, 'path', { value: `/${path}` });
        return file;
      };
      const project = await buildProject([
        ...live.map(([name, data]) => asDropped(name, data as BlobPart)),
        asDropped(backupName, backup as BlobPart),
      ]);
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
    const gerbers = zipSync({ 'gerbers/glasgow-F_Cu.gbr': new Uint8Array([71, 48, 52]) });
    expect(await refusalOf([new File([gerbers], 'gerbers.zip')])).toBe(byWhat['A zip of Gerbers or other outputs']);
    expect(byWhat['A zip of Gerbers or other outputs']).toBe(INTAKE_MESSAGES.empty);
    // A KiCad 5 project, by its names.
    expect(await refusalOf([new File(['EESchema'], 'old.sch'), new File(['x'], 'old.pro')])).toBe(KICAD5_MESSAGE);
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
