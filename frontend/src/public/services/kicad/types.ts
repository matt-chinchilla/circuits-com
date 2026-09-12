// Shared shapes for the KiCad reader (spec §4). Pure data; no DOM.

export type SExpr = string | SExpr[];

export interface KicadSheet {
  /** Normalized relative path — the `files` key. */
  path: string;
  /** The schematic file's own (uuid …), used to build instance paths. */
  uuid: string;
  text: string;
}

export interface KicadProject {
  name: string;
  /** Normalized relative path → text. Never keyed by basename alone. */
  files: Map<string, string>;
  pro: { sheets: [uuid: string, name: string][] } | null;
  /** Path key of the root schematic, or null when the drop had no schematic. */
  root: string | null;
  /** Root first, then breadth-first through Sheetfile references, unique by path. */
  sheets: KicadSheet[];
  /** Path key of the board, or null. */
  board: string | null;
  warnings: string[];
  /** Sheetfile references that resolved to nothing (or to more than one file). */
  missingSheets: string[];
  formatVersions: Record<string, number>;
}

export interface CopperLayer {
  /** 1-based position among the copper rows in file order (KiCad writes top → bottom). */
  ordinal: number;
  name: string;
  /** Signal | Plane | Mixed | Jumper, or the raw token when KiCad emits something new. */
  kind: string;
}

export interface StackupRow {
  name: string;
  type: string;
  thicknessMm: number | null;
  material: string | null;
  epsilonR: number | null;
  lossTangent: number | null;
}

export type ViaType = 'through' | 'blind' | 'micro' | 'unknown';

export interface ViaGroup {
  type: ViaType;
  start: string;
  end: string;
  count: number;
}

export interface BoardStackup {
  copperLayers: CopperLayer[];
  /** null = the board has no (setup (stackup …)) block. Never defaulted. */
  stackup: StackupRow[] | null;
  copperFinish: string | null;
  /** Sum of every thickness present in the stackup block; labelled as that sum. */
  listedThicknessMm: number | null;
  /** (general (thickness X)) — a design setting, shown separately. */
  designThicknessMm: number | null;
  vias: ViaGroup[];
  layerCount: number;
}

/** Applied AFTER the ignore filter, to the files the tool will actually read.
 *  Owner-approved at the Phase 0 gate (spec §4.2, §9). */
export const INTAKE_CAPS = {
  files: 40,
  perFileBytes: 8 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
} as const;

/** Bomb protection for a dropped archive, independent of what the tool reads. */
export const ARCHIVE_GUARD = {
  archiveBytes: 60 * 1024 * 1024,
  declaredTotalBytes: 250 * 1024 * 1024,
  maxRatio: 100,
} as const;

/** KiCad 6.0's board format. Anything lower is KiCad 5. */
export const MIN_BOARD_VERSION = 20211014;

export const KICAD5_MESSAGE =
  'This is a KiCad 5 project. Open it in KiCad 6 or newer and save it — that rewrites it in the format this viewer reads.';

export type KicadReadErrorKind = 'kicad5' | 'cap' | 'archive' | 'empty' | 'unreadable';

export class KicadReadError extends Error {
  readonly kind: KicadReadErrorKind;

  constructor(message: string, kind: KicadReadErrorKind) {
    super(message);
    this.name = 'KicadReadError';
    this.kind = kind;
  }
}

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}
