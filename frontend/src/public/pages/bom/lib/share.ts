import type { ParsedBomLine } from './parseBom';
import type { BomOffer, BomRow, BomRowStatus, TableRow } from './types';

/**
 * The share payload — the ONE shape written by "Share this BOM" and read back
 * by `/bom/s/:slug`.
 *
 * The server stores this blob verbatim and has no opinion about it (it is a
 * JSON column and a slug), so BOTH halves of the contract live here: a
 * builder that decides what leaves the browser, and a parser that refuses to
 * trust what comes back. A link is durable and this format is not frozen —
 * `createdWith` is what lets a later reader recognise a payload it cannot
 * render instead of half-rendering it.
 *
 * What ships is exactly what the reader is told ships: the parsed lines
 * (parts, quantities, designators) plus the catalog answers already on their
 * screen. The uploaded file, the raw text and the header mapping do not.
 */

export const SHARE_FORMAT = 'bom-v1';

export interface SharePayload {
  createdWith: string;
  buildQty: number;
  includeDnp: boolean;
  lines: ParsedBomLine[];
  /** Keyed by line index as a STRING — JSON object keys always are, and
   *  pretending otherwise is how a round trip loses rows. */
  rowsByIndex: Record<string, BomRow>;
}

export interface HydratedShare {
  rows: TableRow[];
  buildQty: number;
  includeDnp: boolean;
}

/** Fields are listed rather than rest-spread off the TableRow: the payload is
 *  a wire contract, and a field added to the client row model later must be
 *  an explicit decision to publish, not an accident of destructuring. */
function toLine(row: TableRow): ParsedBomLine {
  return {
    index: row.index,
    mpn: row.mpn,
    value: row.value,
    footprint: row.footprint,
    description: row.description,
    manufacturer: row.manufacturer,
    distributorPn: row.distributorPn,
    qty: row.qty,
    refs: row.refs,
    dnp: row.dnp,
  };
}

export function buildSharePayload(
  rows: TableRow[],
  buildQty: number,
  includeDnp: boolean,
): SharePayload {
  const rowsByIndex: Record<string, BomRow> = {};
  for (const row of rows) {
    if (row.server != null) rowsByIndex[String(row.index)] = row.server;
  }
  return {
    createdWith: SHARE_FORMAT,
    buildQty,
    includeDnp,
    lines: rows.map(toLine),
    rowsByIndex,
  };
}

// ─── Reading one back ───────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const ROW_STATUSES: BomRowStatus[] = ['exact', 'approx', 'resolve', 'none', 'exact_live'];

function parseLine(value: unknown): ParsedBomLine | null {
  const raw = asRecord(value);
  if (raw == null) return null;
  const index = raw.index;
  if (typeof index !== 'number' || !Number.isFinite(index)) return null;
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((r): r is string => typeof r === 'string') : [];
  return {
    index,
    mpn: asText(raw.mpn),
    value: asText(raw.value),
    footprint: asText(raw.footprint),
    description: asText(raw.description),
    manufacturer: asText(raw.manufacturer),
    distributorPn: asText(raw.distributorPn),
    qty: asCount(raw.qty, 1),
    refs,
    dnp: raw.dnp === true,
  };
}

/**
 * A stored row, checked only as far as the table actually reads it.
 *
 * The offers list is the load-bearing part — every price on the shared page is
 * recomputed from those break tables — so an offer missing its identity or its
 * ladder is dropped rather than rendered as a free part.
 */
function parseRow(value: unknown): BomRow | null {
  const raw = asRecord(value);
  if (raw == null) return null;
  const index = raw.index;
  const status = raw.status;
  if (typeof index !== 'number' || typeof status !== 'string') return null;
  if (!ROW_STATUSES.includes(status as BomRowStatus)) return null;
  const offers = Array.isArray(raw.offers)
    ? raw.offers.filter((offer): offer is BomOffer => {
        const o = asRecord(offer);
        return (
          o != null &&
          typeof o.supplier_id === 'string' &&
          typeof o.supplier_name === 'string' &&
          Array.isArray(o.breaks)
        );
      })
    : [];
  return {
    index,
    status: status as BomRowStatus,
    approx_reason: asText(raw.approx_reason),
    package_warning: asText(raw.package_warning),
    resolve_query: asText(raw.resolve_query),
    part: (asRecord(raw.part) as BomRow['part']) ?? null,
    recommended_supplier_id: asText(raw.recommended_supplier_id),
    offers,
  };
}

/**
 * Hydrate a stored payload, or refuse it.
 *
 * `null` means "this link cannot be rendered" and the page says exactly that —
 * a partially-read BOM would be a priced table with lines silently missing,
 * which is the one failure this tool cannot afford.
 */
export function parseSharePayload(payload: unknown): HydratedShare | null {
  const raw = asRecord(payload);
  if (raw == null || !Array.isArray(raw.lines)) return null;

  const rowsByIndex = asRecord(raw.rowsByIndex) ?? {};
  const rows: TableRow[] = [];
  for (const entry of raw.lines) {
    const line = parseLine(entry);
    if (line == null) return null;
    const server = parseRow(rowsByIndex[String(line.index)]);
    rows.push({
      ...line,
      server,
      // A shared row is finished: nothing is in flight and nothing will be
      // looked up again, so it renders the answer it was shared with.
      state: server == null ? 'not_found' : 'matched',
      viewerHref: null,
    });
  }
  if (rows.length === 0) return null;

  return {
    rows,
    buildQty: Math.max(1, Math.trunc(asCount(raw.buildQty, 1))),
    includeDnp: raw.includeDnp === true,
  };
}
