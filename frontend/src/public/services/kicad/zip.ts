// A dropped archive enters through fflate's `filter`, which sees each entry's
// declared sizes and runs before THAT entry inflates (spec §4.5) — but fflate
// inflates every accepted entry inside the same central-directory loop, so a
// later entry's throw lands after the earlier ones have already inflated and the
// bound is the running declared total, not zero bytes. Two guards, deliberately
// separate: the ARCHIVE guard bounds the inflate (declared
// sizes are attacker-controlled, so the archive-size and ratio caps are what
// actually hold), and the INTAKE caps in project.ts apply only to the KiCad
// files that survive the name filter — nothing else is ever inflated.
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { ARCHIVE_GUARD, KicadReadError, formatMb } from './types';

/** The files the reader opens: project, schematic sheets, board. */
export const MODERN_KICAD_EXTENSIONS = ['.kicad_pro', '.kicad_sch', '.kicad_pcb'] as const;
/** KiCad 5's names — admitted ONLY so the drop can be refused by name. */
export const LEGACY_KICAD_EXTENSIONS = ['.sch', '.pro'] as const;
export const KICAD_EXTENSIONS = [...MODERN_KICAD_EXTENSIONS, ...LEGACY_KICAD_EXTENSIONS] as const;

export function normalizeEntryName(name: string): string | null {
  const slashed = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (slashed === '' || slashed.endsWith('/')) return null;
  const parts = slashed.split('/');
  if (parts.some((seg) => seg === '..' || seg === '')) return null;
  // A trailing `.` names the directory itself ("a/." is "a/"), never a file.
  if (parts[parts.length - 1] === '.') return null;
  return parts.filter((seg) => seg !== '.').join('/');
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
  // fflate hands entries back in zip order; a path-sorted result is a stable
  // contract for the project assembler and for tests that index into it.
  const sorted = Object.entries(entries)
    .map(([name, data]) => [normalizeEntryName(name) ?? name, data] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Two entries that normalize to one path (a/b vs a\b) would let the later
  // copy shadow a real sheet in the project's path-keyed Map — refuse instead.
  for (let i = 1; i < sorted.length; i++) {
    const name = sorted[i]![0];
    if (name === sorted[i - 1]![0]) {
      throw new KicadReadError(`That archive names the same file twice: ${name}.`, 'archive');
    }
  }
  return sorted.map(([name, data]) => new File([data], name));
}
