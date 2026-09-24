// frontend/src/public/services/kicad/project.ts
// Dropped files (or one zip) → KicadProject (spec §4.2). Files are keyed by
// normalized relative path; Sheetfile references resolve relative to the sheet
// that names them, then by a UNIQUE basename, never by traversal. KiCad 5 is
// refused before anything mounts; the intake caps apply after the ignore
// filter, to the files the tool will actually read.
import { KICAD_BACKUP_ZIP, LEGACY_KICAD_EXTENSIONS, isIgnoredPath, isKicadName, normalizeEntryName, unzipToFiles } from './zip';
import {
  INTAKE_CAPS,
  KICAD5_MESSAGE,
  KicadReadError,
  MIN_BOARD_VERSION,
  formatMb,
  type KicadProject,
  type KicadSheet,
} from './types';

const LEGACY_EXTENSIONS: readonly string[] = LEGACY_KICAD_EXTENSIONS;
const SHEETFILE = /\(property\s+"Sheetfile"\s+"([^"]*)"/g;
const VERSION = /\(kicad_(?:sch|pcb)\s*\(version\s+(\d+)\)/;
const DOC_UUID = /\(kicad_sch[\s\S]{0,400}?\(uuid\s+"?([0-9a-fA-F-]{36})"?\)/;
const MAX_DEPTH = 32;

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i).toLowerCase();
}

function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i < 0 ? b : b.slice(0, i);
}

export function versionOf(text: string): number | null {
  const m = VERSION.exec(text.slice(0, 400));
  return m ? Number(m[1]) : null;
}

export function schematicUuid(text: string): string | null {
  const m = DOC_UUID.exec(text.slice(0, 2000));
  return m ? (m[1] as string).toLowerCase() : null;
}

export type SheetResolution = { path: string; byName: boolean } | { missing: true; candidates: string[] };

export function resolveSheetRef(fromPath: string, ref: string, known: Iterable<string>): SheetResolution {
  const keys = [...known];
  const dir = dirname(fromPath);
  const joined = normalizeEntryName(dir === '' ? ref : `${dir}/${ref}`);
  if (joined != null && keys.includes(joined)) return { path: joined, byName: false };
  if (ref.replace(/\\/g, '/').split('/').includes('..')) return { missing: true, candidates: [] };
  const name = basename(ref.replace(/\\/g, '/'));
  const candidates = keys.filter((k) => basename(k) === name).sort();
  if (candidates.length === 1) return { path: candidates[0] as string, byName: true };
  return { missing: true, candidates };
}

// The actual size is rounded UP to a tenth: at the exact boundary a plain
// round renders "is 8.0 MB; the limit per file is 8.0 MB", which reads as a
// contradiction. The limits keep formatMb — they are exact by construction.
function formatMbUp(bytes: number): string {
  return (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
}

function capError(message: string): KicadReadError {
  return new KicadReadError(message, 'cap');
}

/**
 * Every refusal this module words, as the reader will see it. Exported so the
 * /viewer guide can print the REAL sentences ("What a turned-away file looks
 * like") instead of a retyped copy that drifts.
 */
export const INTAKE_MESSAGES = {
  empty: 'No KiCad files in what was dropped — looking for .kicad_pro, .kicad_sch and .kicad_pcb.',
  projectOnly: 'That project has no schematic or board to show — only a .kicad_pro was found.',
  tooManyFiles: (count: number) => `That is ${count} KiCad files; the limit is ${INTAKE_CAPS.files}.`,
  fileTooLarge: (name: string, bytes: number) =>
    `${name} is ${formatMbUp(bytes)} MB; the limit per file is ${formatMb(INTAKE_CAPS.perFileBytes)} MB.`,
  totalTooLarge: (bytes: number) => `Those files total ${formatMbUp(bytes)} MB; the limit is ${formatMb(INTAKE_CAPS.totalBytes)} MB.`,
} as const;

type PathedFile = File & { webkitRelativePath?: string; relativePath?: string; path?: string };

/**
 * Where a dropped file sat in the project. A picked folder carries
 * webkitRelativePath; a DRAGGED folder arrives through react-dropzone's
 * file-selector, which leaves that empty and puts the nested path on its own
 * `relativePath` / `path` ("/glasgow/glasgow-backups/x.zip"; a picked file gets
 * "./name"). A file unpacked from a zip carries its entry path as its name.
 */
export function inputPath(file: File): string | null {
  const f = file as PathedFile;
  return normalizeEntryName(f.webkitRelativePath || f.relativePath || f.path || file.name);
}

export async function buildProject(input: File[]): Promise<KicadProject> {
  const expanded: { path: string; file: File }[] = [];
  for (const file of input) {
    const path = inputPath(file);
    if (path == null) continue;
    if (path.toLowerCase().endsWith('.zip')) {
      // A zip in a -backups/ folder is KiCad's, never the project. A drag that
      // lost the folder path still carries KiCad's timestamped backup NAME —
      // skipped whenever it arrives beside other files (a folder drag); a
      // backup dropped on its own is opened, since that is on purpose.
      if (isIgnoredPath(path) || (input.length > 1 && KICAD_BACKUP_ZIP.test(path))) continue;
      for (const entry of await unzipToFiles(file)) expanded.push({ path: normalizeEntryName(entry.name) ?? entry.name, file: entry });
    } else {
      expanded.push({ path, file });
    }
  }

  const candidates: { path: string; file: File }[] = [];
  for (const { path, file } of expanded) {
    if (isIgnoredPath(path) || !isKicadName(path)) continue;
    candidates.push({ path, file });
  }
  if (candidates.length === 0) {
    throw new KicadReadError(INTAKE_MESSAGES.empty, 'empty');
  }

  const modern = candidates.filter((c) => !LEGACY_EXTENSIONS.includes(extensionOf(c.path)));
  if (modern.length === 0) throw new KicadReadError(KICAD5_MESSAGE, 'kicad5');

  if (modern.length > INTAKE_CAPS.files) throw capError(INTAKE_MESSAGES.tooManyFiles(modern.length));
  let total = 0;
  for (const c of modern) {
    if (c.file.size > INTAKE_CAPS.perFileBytes) throw capError(INTAKE_MESSAGES.fileTooLarge(basename(c.path), c.file.size));
    total += c.file.size;
  }
  if (total > INTAKE_CAPS.totalBytes) throw capError(INTAKE_MESSAGES.totalTooLarge(total));

  const warnings: string[] = [];
  const files = new Map<string, string>();
  for (const c of modern) {
    if (files.has(c.path)) warnings.push(`${c.path} was dropped twice; the last copy is the one shown.`);
    files.set(c.path, await c.file.text());
  }

  const formatVersions: Record<string, number> = {};
  for (const [path, text] of files) {
    const v = versionOf(text);
    if (v != null) formatVersions[path] = v;
    if (extensionOf(path) === '.kicad_pcb' && v != null && v < MIN_BOARD_VERSION) throw new KicadReadError(KICAD5_MESSAGE, 'kicad5');
  }

  const pros = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_pro');
  const proPath = pros[0] ?? null;
  if (pros.length > 1) warnings.push(`${pros.length} project files were dropped; using ${basename(proPath as string)}.`);
  let pro: KicadProject['pro'] = null;
  if (proPath != null) {
    try {
      const json = JSON.parse(files.get(proPath) as string) as { sheets?: unknown };
      const sheets = Array.isArray(json.sheets)
        ? json.sheets.filter((s): s is [string, string] => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string')
        : [];
      pro = { sheets };
    } catch {
      warnings.push('The project file could not be read; sheet names come from the schematics instead.');
    }
  }

  const schematicPaths = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_sch');
  const refsOf = (path: string): string[] => {
    const out: string[] = [];
    const text = files.get(path) as string;
    for (const m of text.matchAll(SHEETFILE)) if (m[1]) out.push(m[1]);
    return out;
  };
  const referenced = new Set<string>();
  for (const p of schematicPaths) {
    for (const ref of refsOf(p)) {
      const r = resolveSheetRef(p, ref, schematicPaths);
      if (!('missing' in r)) referenced.add(r.path);
    }
  }
  let root: string | null = null;
  if (proPath != null) root = schematicPaths.find((p) => dirname(p) === dirname(proPath) && stem(p) === stem(proPath)) ?? null;
  if (root == null) root = schematicPaths.find((p) => !referenced.has(p)) ?? null;
  if (root == null) root = schematicPaths[0] ?? null;

  const sheets: KicadSheet[] = [];
  const missingSheets: string[] = [];
  const seen = new Set<string>();
  const queue: { path: string; depth: number }[] = root == null ? [] : [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    if (seen.has(path)) continue;
    seen.add(path);
    const text = files.get(path) as string;
    sheets.push({ path, uuid: schematicUuid(text) ?? '', text });
    if (depth >= MAX_DEPTH) {
      warnings.push(`${basename(path)} is nested more than ${MAX_DEPTH} sheets deep; deeper sheets were not read.`);
      continue;
    }
    for (const ref of refsOf(path)) {
      const r = resolveSheetRef(path, ref, schematicPaths);
      if ('missing' in r) {
        if (!missingSheets.includes(ref)) missingSheets.push(ref);
        if (r.candidates.length > 1) warnings.push(`${basename(path)} references ${ref}, which matches more than one file (${r.candidates.join(', ')}); add the folder so the reference is exact.`);
        continue;
      }
      if (r.byName) warnings.push(`${basename(path)} references ${ref}; matched ${r.path} by name.`);
      queue.push({ path: r.path, depth: depth + 1 });
    }
  }
  const unreachable = schematicPaths.filter((p) => !seen.has(p));
  if (unreachable.length > 0) warnings.push(`${unreachable.length} schematic file(s) are not reachable from the root sheet and are not shown: ${unreachable.map(basename).join(', ')}.`);

  const boards = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_pcb');
  const board = boards[0] ?? null;
  if (boards.length > 1) warnings.push(`${boards.length} boards were dropped; showing ${basename(board as string)}.`);

  // A drop that yields neither a root schematic nor a board has nothing to
  // render — a lone .kicad_pro is the common case. Board-only projects are
  // legitimate, so the predicate needs BOTH to be absent.
  if (root == null && board == null) {
    throw new KicadReadError(INTAKE_MESSAGES.projectOnly, 'empty');
  }

  const name = proPath != null ? stem(proPath) : root != null ? stem(root) : board != null ? stem(board) : 'design';
  return { name, files, pro, root, sheets, board, warnings, missingSheets, formatVersions };
}
