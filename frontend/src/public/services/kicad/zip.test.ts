import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_GUARD, KicadReadError } from './types';
import { isIgnoredPath, isKicadName, normalizeEntryName, unzipToFiles } from './zip';

function zipFile(entries: Record<string, string | Uint8Array>, name = 'p.zip'): File {
  const data: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) data[k] = typeof v === 'string' ? strToU8(v) : v;
  return new File([zipSync(data, { level: 6 })], name);
}

describe('normalizeEntryName', () => {
  it('normalizes slashes, strips a leading slash, rejects traversal and directories', () => {
    expect(normalizeEntryName('a\\b.kicad_sch')).toBe('a/b.kicad_sch');
    expect(normalizeEntryName('/root/x.kicad_pcb')).toBe('root/x.kicad_pcb');
    expect(normalizeEntryName('../x.kicad_sch')).toBeNull();
    expect(normalizeEntryName('a/../x.kicad_sch')).toBeNull();
    expect(normalizeEntryName('dir/')).toBeNull();
    expect(normalizeEntryName('.')).toBeNull();
    expect(normalizeEntryName('a/.')).toBeNull();
    expect(normalizeEntryName('./x.kicad_sch')).toBe('x.kicad_sch');
  });
});

describe('name filters', () => {
  it('accepts KiCad files including the KiCad 5 names used only for detection', () => {
    for (const n of ['a.kicad_pro', 'a.kicad_sch', 'a.KICAD_PCB', 'old.sch', 'old.pro']) expect(isKicadName(n)).toBe(true);
    for (const n of ['a.kicad_prl', 'a.kicad_sym', 'a.step', 'x.gbr', 'fp-info-cache']) expect(isKicadName(n)).toBe(false);
  });
  it('ignores backups and the footprint cache', () => {
    expect(isIgnoredPath('proj-backups/proj-2024.zip')).toBe(true);
    expect(isIgnoredPath('sub/fp-info-cache')).toBe(true);
    expect(isIgnoredPath('sub/main.kicad_sch')).toBe(false);
  });
});

describe('unzipToFiles', () => {
  it('returns only KiCad files, keyed by their relative path, and never inflates the rest', async () => {
    const files = await unzipToFiles(
      zipFile({ 'board/main.kicad_sch': '(kicad_sch)', 'board/sub/io.kicad_sch': '(kicad_sch)', 'board/main.kicad_pcb': '(kicad_pcb)', 'board/model.step': 'x'.repeat(5000), 'board-backups/old.zip': 'zzz' }),
    );
    expect(files.map((f) => f.name).sort()).toEqual(['board/main.kicad_pcb', 'board/main.kicad_sch', 'board/sub/io.kicad_sch']);
    expect(await files[0]!.text()).toBe('(kicad_pcb)');
  });

  it('refuses an archive over the archive cap without reading it (guard injected small)', async () => {
    const small = zipFile({ 'x.kicad_sch': '(kicad_sch)' });
    await expect(unzipToFiles(small, { ...ARCHIVE_GUARD, archiveBytes: 16 })).rejects.toMatchObject({ kind: 'archive' } satisfies Partial<KicadReadError>);
  });

  it('refuses an entry compressed past the ratio cap before inflating it', async () => {
    // 512 KB of one repeated byte deflates far past 100:1; the production guard applies.
    const bomb = zipFile({ 'x.kicad_sch': new Uint8Array(512 * 1024) });
    await expect(unzipToFiles(bomb)).rejects.toMatchObject({ kind: 'archive' });
  });

  it('refuses when the declared uncompressed total is over the guard (guard injected small)', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 5; i++) entries[`s${i}.kicad_sch`] = `(kicad_sch (version 20250114) (uuid "u${i}") ${'(junk "x")'.repeat(40)})`;
    await expect(unzipToFiles(zipFile(entries), { ...ARCHIVE_GUARD, declaredTotalBytes: 1024 })).rejects.toMatchObject({ kind: 'archive' });
  });

  it('refuses an archive whose entries collide after normalization', async () => {
    await expect(unzipToFiles(zipFile({ 'a/b.kicad_sch': '(kicad_sch)', 'a\\b.kicad_sch': '(kicad_sch)' }))).rejects.toMatchObject({ kind: 'archive' });
  });
});
