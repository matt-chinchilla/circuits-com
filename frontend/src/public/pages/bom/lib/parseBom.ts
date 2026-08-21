import { parse as parseCsv } from 'papaparse';
import { matchHeader, normalizeHeader, type BomRole } from './headerAliases';

/**
 * BOM text -> lines. Pure functions only; every behavior here is pinned by an
 * attested fixture in `fixtures.ts` and by the detector rules in
 * `docs/design-briefs/bom-kicad-research-2026-08-19.md`.
 */

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

/** A metadata preamble is five lines in the worst attested case; ten is slack. */
const HEADER_SCAN_ROWS = 10;
/** One lucky hit is a coincidence; two is a header row. */
const MIN_HEADER_HITS = 2;
/** How many offenders an aggregated warning names before it says "+N more". */
const WARN_NAME_LIMIT = 8;

const REF_RANGE = /^([A-Za-z]+)(\d+)-([A-Za-z]*)(\d+)$/;

/**
 * Prefix-aware reference expansion. Splits on ',' — which also absorbs the
 * legacy exporters' comma+SPACE join regime once each token is trimmed — then
 * expands `R1-R3` style ranges. A range whose two prefixes disagree (`R1-C3`)
 * is NOT a range; it stays literal rather than inventing designators.
 */
export function expandRefs(cell: string): string[] {
  const out: string[] = [];
  for (const rawToken of cell.split(',')) {
    const token = rawToken.trim();
    if (!token) continue;
    const m = REF_RANGE.exec(token);
    if (!m) {
      out.push(token);
      continue;
    }
    const [, prefix, startText, endPrefix, endText] = m;
    if (endPrefix !== '' && endPrefix.toLowerCase() !== prefix.toLowerCase()) {
      out.push(token);
      continue;
    }
    const start = Number.parseInt(startText, 10);
    const end = Number.parseInt(endText, 10);
    if (end < start || end - start > MAX_REFS_PER_LINE) {
      out.push(token);
      continue;
    }
    for (let n = start; n <= end; n += 1) out.push(`${prefix}${n}`);
  }
  return out;
}

function parseRows(text: string): string[][] {
  const out = parseCsv<string[]>(text.replace(/^\uFEFF/, ''), {
    delimiter: '',
    delimitersToGuess: [',', ';', '\t'],
    skipEmptyLines: 'greedy',
  });
  return out.data.filter((row) => Array.isArray(row) && row.some((cell) => cell.trim() !== ''));
}

/**
 * Score the first rows by alias hits and take the best. The preamble rows of
 * the legacy exporters score zero, so the real header wins without any
 * "skip N lines" guesswork. Ties keep the EARLIEST row.
 */
function scanHeader(rows: string[][]): number {
  let bestIdx = -1;
  let bestHits = 0;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i += 1) {
    let hits = 0;
    for (const cell of rows[i]) if (matchHeader(cell) !== null) hits += 1;
    if (hits > bestHits) {
      bestHits = hits;
      bestIdx = i;
    }
  }
  return bestHits >= MIN_HEADER_HITS ? bestIdx : -1;
}

function signatureOf(headers: string[]): string {
  return headers.map((h) => normalizeHeader(h)).join('');
}

function nameList(items: string[]): string {
  const shown = items.slice(0, WARN_NAME_LIMIT).join(', ');
  return items.length > WARN_NAME_LIMIT
    ? `${shown}, +${items.length - WARN_NAME_LIMIT} more`
    : shown;
}

interface BuiltLines {
  lines: ParsedBomLine[];
  warnings: string[];
  error: string | null;
}

/**
 * The ONE materializer. Both entry points — the auto-mapped `parseBomText` and
 * the mapper's `applyRoleMap` — come through here, so a role decided by a human
 * behaves exactly like a role decided by the alias table.
 */
function buildLines(
  rows: string[][],
  headerRowIdx: number,
  roles: (BomRole | null)[],
): BuiltLines {
  const warnings: string[] = [];
  const dataRows = rows.slice(headerRowIdx + 1);

  if (dataRows.length > MAX_LINES) {
    return {
      lines: [],
      warnings,
      error:
        `That BOM has ${dataRows.length.toLocaleString('en-US')} lines — this tool prices up to `
        + '2,000 at a time. Split it and price each half.',
    };
  }
  if (dataRows.length === 0) {
    return {
      lines: [],
      warnings,
      error: 'That file has a header row but no component lines.',
    };
  }

  // First column wins per role: a legacy export carries both `Value` and
  // `Cmp name` and the leftmost is the one the exporter treats as the value.
  const columnOf: Partial<Record<BomRole, number>> = {};
  roles.forEach((role, i) => {
    if (role !== null && columnOf[role] === undefined) columnOf[role] = i;
  });
  const refsIdx = columnOf.refs;
  const headerLen = roles.length;

  const lines: ParsedBomLine[] = [];
  const seenRefs = new Set<string>();
  const duplicates = new Set<string>();
  const qtyFallbackLines: number[] = [];

  dataRows.forEach((rawRow, i) => {
    const index = i + 1;
    let row = rawRow;

    // The unquoted multi-ref hazard: cells > headers is the ONLY signal, so
    // fold the surplus back into the refs cell it was split out of.
    if (row.length > headerLen && refsIdx !== undefined) {
      const extra = row.length - headerLen;
      row = [
        ...row.slice(0, refsIdx),
        row.slice(refsIdx, refsIdx + extra + 1).join(','),
        ...row.slice(refsIdx + extra + 1),
      ];
    }

    const at = (role: BomRole): string => {
      const col = columnOf[role];
      return col === undefined ? '' : (row[col] ?? '').trim();
    };
    const orNull = (role: BomRole): string | null => at(role) || null;

    let refs = at('refs') ? expandRefs(at('refs')) : [];
    if (refs.length > MAX_REFS_PER_LINE) {
      warnings.push(
        `Line ${index} carries ${refs.length} designators — over the ${MAX_REFS_PER_LINE}-per-line `
        + 'limit, so the rest were dropped.',
      );
      refs = refs.slice(0, MAX_REFS_PER_LINE);
    }
    for (const ref of refs) {
      if (seenRefs.has(ref)) duplicates.add(ref);
      else seenRefs.add(ref);
    }

    const parsedQty = Number.parseInt(at('qty'), 10);
    let qty = parsedQty;
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      qty = refs.length || 1;
      qtyFallbackLines.push(index);
    }

    lines.push({
      index,
      mpn: orNull('mpn'),
      value: orNull('value'),
      footprint: orNull('footprint'),
      description: orNull('description'),
      manufacturer: orNull('manufacturer'),
      distributorPn: orNull('distributor_pn'),
      qty,
      refs,
      // Attribute columns are string-or-empty. Never parse for true/false/Y.
      dnp: at('dnp') !== '',
    });
  });

  if (qtyFallbackLines.length) {
    warnings.push(
      `No usable quantity on ${qtyFallbackLines.length} line(s) `
      + `(${nameList(qtyFallbackLines.map(String))}) — used the designator count, or 1.`,
    );
  }
  if (duplicates.size) {
    warnings.push(
      `Repeated designator${duplicates.size > 1 ? 's' : ''}: ${nameList([...duplicates])} — each `
      + 'should appear once across the whole file.',
    );
  }

  return { lines, warnings, error: null };
}

function materialize(
  rows: string[][],
  headerRowIdx: number,
  headers: string[],
  roles: (BomRole | null)[],
): ParseResult {
  const { lines, warnings, error } = buildLines(rows, headerRowIdx, roles);
  return {
    lines,
    headers,
    headerSignature: signatureOf(headers),
    roleByColumn: roles,
    unmappedColumns: roles.flatMap((role, i) => (role === null ? [i] : [])),
    warnings,
    error,
  };
}

export function parseBomText(text: string): ParseResult {
  const rows = parseRows(text);
  if (rows.length === 0) {
    return {
      lines: [],
      headers: [],
      headerSignature: '',
      roleByColumn: [],
      unmappedColumns: [],
      warnings: [],
      error: 'That file has no rows to read.',
    };
  }

  const headerRowIdx = scanHeader(rows);
  if (headerRowIdx < 0) {
    // An unreadable header is a mapper moment, not a failure (spec section 9):
    // hand back the first row as candidate headers with every column unmapped.
    const headers = rows[0];
    return {
      lines: [],
      headers,
      headerSignature: signatureOf(headers),
      roleByColumn: headers.map(() => null),
      unmappedColumns: headers.map((_, i) => i),
      warnings: [],
      error: null,
    };
  }

  const headers = rows[headerRowIdx];
  return materialize(rows, headerRowIdx, headers, headers.map((h) => matchHeader(h)));
}

/**
 * The mapper path: re-parse the same text, then materialize with the roles the
 * user chose. Same header row, same repair rules, same line factory.
 */
export function applyRoleMap(text: string, roles: (BomRole | null)[]): ParseResult {
  const rows = parseRows(text);
  if (rows.length === 0) return parseBomText(text);
  const scanned = scanHeader(rows);
  const headerRowIdx = scanned < 0 ? 0 : scanned;
  const headers = rows[headerRowIdx];
  return materialize(rows, headerRowIdx, headers, headers.map((_, i) => roles[i] ?? null));
}

/**
 * The mapper's preview: the first data rows exactly as the parser split them,
 * so the cells a person sees under a header are the cells that column will
 * contribute. Lives here rather than in the component because the header-row
 * scan and the delimiter guess must be the SAME ones the map will be applied
 * with — a second, simpler split in the UI could show a different column.
 */
export function previewRows(text: string, limit = 3): string[][] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const scanned = scanHeader(rows);
  return rows.slice((scanned < 0 ? 0 : scanned) + 1, (scanned < 0 ? 0 : scanned) + 1 + limit);
}

/** `PART[ ,|]QTY`, one per line — the Mouser paste grammar. */
const PASTE_LINE = /^(.*?)[\s,|]+(.*)$/;

/**
 * The paste box. Produces the SAME `ParseResult` shape as a file so the page
 * has one downstream path, but it materializes directly: there is no header
 * row to scan and a missing quantity is the documented default, not a fallback
 * worth warning about.
 */
export function parsePasteRows(text: string): ParseResult {
  const headers = ['Part', 'Qty'];
  const roles: (BomRole | null)[] = ['mpn', 'qty'];
  const base = {
    headers,
    headerSignature: signatureOf(headers),
    roleByColumn: roles,
    unmappedColumns: [] as number[],
  };

  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (rawLines.length > MAX_LINES) {
    return {
      ...base,
      lines: [],
      warnings: [],
      error:
        `That paste has ${rawLines.length.toLocaleString('en-US')} lines — this tool prices up to `
        + '2,000 at a time. Split it and price each half.',
    };
  }

  const lines: ParsedBomLine[] = rawLines.map((raw, i) => {
    const m = PASTE_LINE.exec(raw);
    const part = (m ? m[1] : raw).trim();
    const qtyText = m ? m[2].trim() : '';
    const parsedQty = Number.parseInt(qtyText, 10);
    return {
      index: i + 1,
      mpn: part || null,
      value: null,
      footprint: null,
      description: null,
      manufacturer: null,
      distributorPn: null,
      qty: Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1,
      refs: [],
      dnp: false,
    };
  });

  return {
    ...base,
    lines,
    warnings: [],
    error: lines.length === 0 ? 'Nothing to price — paste one part per line.' : null,
  };
}
