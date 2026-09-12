// A dropped archive enters through fflate's `filter`, which runs BEFORE any
// entry is inflated and sees each entry's declared sizes (spec §4.5). Two
// guards, deliberately separate: the ARCHIVE guard bounds the inflate (declared
// sizes are attacker-controlled, so the archive-size and ratio caps are what
// actually hold), and the INTAKE caps in project.ts apply only to the KiCad
// files that survive the name filter — nothing else is ever inflated.
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { ARCHIVE_GUARD, KicadReadError, formatMb } from './types';

export const KICAD_EXTENSIONS = ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'] as const;

export function normalizeEntryName(name: string): string | null {
  const slashed = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (slashed === '' || slashed.endsWith('/')) return null;
  const parts = slashed.split('/');
  if (parts.some((seg) => seg === '..' || seg === '')) return null;
  const joined = parts.filter((seg) => seg !== '.').join('/');
  return joined === '' ? null : joined;
}

export function isKicadName(path: string): boolean {
  const lower = path.toLowerCase();
  return KICAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isIgnoredPath(path: string): boolean {
  return path.includes('-backups/') || path.endsWith('fp-info-cache');
}

export type ArchiveGuard = { archiveBytes: number; declaredTotalBytes: number; maxRatio: number };

export async function unzipToFiles(file: File, guard: ArchiveGuard = ARCHIVE_GUARD): Promise<File[]> {
  if (file.size > guard.archiveBytes) {
    throw new KicadReadError(
      `That archive is ${formatMb(file.size)} MB; the limit is ${formatMb(guard.archiveBytes)} MB.`,
      'archive',
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let declared = 0;
  const filter = (info: UnzipFileInfo): boolean => {
    const name = normalizeEntryName(info.name);
    if (name == null || isIgnoredPath(name) || !isKicadName(name)) return false;
    // size 0 → no compressed bytes to expand; the declared-total cap is the bound.
    if (info.size > 0 && info.originalSize / info.size > guard.maxRatio) {
      throw new KicadReadError(
        `That archive has an entry compressed more than ${guard.maxRatio}:1, so it was not opened.`,
        'archive',
      );
    }
    declared += info.originalSize;
    if (declared > guard.declaredTotalBytes) {
      throw new KicadReadError(
        `That archive declares more than ${formatMb(guard.declaredTotalBytes)} MB of files, so it was not opened.`,
        'archive',
      );
    }
    return true;
  };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter });
  } catch (err) {
    if (err instanceof KicadReadError) throw err;
    throw new KicadReadError('That file is not a zip archive this browser can open.', 'unreadable');
  }
  const sorted = Object.entries(entries)
    .map(([name, data]) => [normalizeEntryName(name) ?? name, data] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const name = sorted[i]![0];
    if (name === sorted[i - 1]![0]) {
      throw new KicadReadError(`That archive names the same file twice: ${name}.`, 'archive');
    }
  }
  // fflate hands entries back in zip order; a path-sorted result is a stable
  // contract for the project assembler and for tests that index into it.
  return sorted.map(([name, data]) => new File([data], name));
}
