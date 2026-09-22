// The BOM line vocabulary and its two caps, with NO parser behind them.
//
// Split out of `parseBom.ts` (2026-09-22) because that module imports
// papaparse at the top, and the KiCad reader — which builds the same lines out
// of a schematic and never sees a CSV — was pulling 24 KB of CSV parser into
// `/viewer` for two constants. `parseBom.ts` re-exports everything here, so its
// callers are unchanged; the schematic path imports from this file.
import type { BomRole } from './headerAliases';

export interface ParsedBomLine {
  index: number;
  mpn: string | null;
  value: string | null;
  footprint: string | null;
  description: string | null;
  manufacturer: string | null;
  distributorPn: string | null;
  qty: number;
  refs: string[];
  dnp: boolean;
}

export interface ParseResult {
  lines: ParsedBomLine[];
  /** Raw header cells, in order — what the mapper renders. */
  headers: string[];
  /** Normalized headers joined — the mapper-memory key (Task 15). */
  headerSignature: string;
  roleByColumn: (BomRole | null)[];
  unmappedColumns: number[];
  /** Dup refs, >200 refs/line, qty fallbacks — informative, never blocking. */
  warnings: string[];
  /** Hard failures ONLY: over the line cap, or nothing to read. */
  error: string | null;
}

export const MAX_LINES = 2000;
/** JLCPCB's attested per-line designator cap (packet section 1). */
export const MAX_REFS_PER_LINE = 200;
