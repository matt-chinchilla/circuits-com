// frontend/src/public/services/kicad/project.ts
// Dropped files (or one zip) → KicadProject (spec §4.2). Files are keyed by
// normalized relative path; Sheetfile references resolve relative to the sheet
// that names them, then by a UNIQUE basename, never by traversal. KiCad 5 is
// refused before anything mounts; the intake caps apply after the ignore
// filter, to the files the tool will actually read.
import { isIgnoredPath, isKicadName, normalizeEntryName, unzipToFiles } from './zip';
import {
  INTAKE_CAPS,
  KICAD5_MESSAGE,
  KicadReadError,
  MIN_BOARD_VERSION,
  formatMb,
  type KicadProject,
  type KicadSheet,
} from './types';

const LEGACY_EXTENSIONS = ['.sch', '.pro'];
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

function capError(message: string): KicadReadError {
  return new KicadReadError(message, 'cap');
}

export async function buildProject(input: File[]): Promise<KicadProject> {
  const expanded: File[] = [];
  for (const file of input) {
    if (file.name.toLowerCase().endsWith('.zip')) expanded.push(...(await unzipToFiles(file)));
    else expanded.push(file);
  }

  const candidates: { path: string; file: File }[] = [];
  for (const file of expanded) {
    const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const path = normalizeEntryName(raw);
    if (path == null || isIgnoredPath(path) || !isKicadName(path)) continue;
    candidates.push({ path, file });
  }
  if (candidates.length === 0) {
    throw new KicadReadError('No KiCad files in what was dropped — looking for .kicad_pro, .kicad_sch and .kicad_pcb.', 'empty');
  }

  const modern = candidates.filter((c) => !LEGACY_EXTENSIONS.includes(extensionOf(c.path)));
  if (modern.length === 0) throw new KicadReadError(KICAD5_MESSAGE, 'kicad5');

  if (modern.length > INTAKE_CAPS.files) throw capError(`That is ${modern.length} KiCad files; the limit is ${INTAKE_CAPS.files}.`);
  let total = 0;
  for (const c of modern) {
    if (c.file.size > INTAKE_CAPS.perFileBytes) throw capError(`${basename(c.path)} is ${formatMb(c.file.size)} MB; the limit per file is ${formatMb(INTAKE_CAPS.perFileBytes)} MB.`);
    total += c.file.size;
  }
  if (total > INTAKE_CAPS.totalBytes) throw capError(`Those files total ${formatMb(total)} MB; the limit is ${formatMb(INTAKE_CAPS.totalBytes)} MB.`);

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

  const proPath = [...files.keys()].find((p) => extensionOf(p) === '.kicad_pro') ?? null;
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
  if (unreachable.length > 0) warnings.push(`${unreachable.length} schematic file(s) are not reachable from the root sheet and were not read: ${unreachable.map(basename).join(', ')}.`);

  const boards = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_pcb');
  const board = boards[0] ?? null;
  if (boards.length > 1) warnings.push(`${boards.length} boards were dropped; showing ${basename(board as string)}.`);

  const name = proPath != null ? stem(proPath) : root != null ? stem(root) : board != null ? stem(board) : 'design';
  return { name, files, pro, root, sheets, board, warnings, missingSheets, formatVersions };
}
