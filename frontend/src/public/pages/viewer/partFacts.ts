// What the part panel knows about one reference designator, assembled from the
// three sources the page already holds: the schematic's BOM lines (identity,
// quantity, siblings, sheet), the board's placements (side and position) and
// the workbench's priced rows (catalog match and best price). Pure, so it is
// tested without a DOM and the panel is only a rendering of this record.
//
// Two rules. A fact the sources do not state is null, never guessed — a part
// with no board placement has no position, not (0, 0). And the price is the
// SAME number the BOM table shows for that line: the same `recommend` at the
// same line quantity, so the panel and the table can never disagree.
import type { ParsedBomLine } from '@public/services/bom/bomLines';
import { priceAt, recommend, tierRankFromOffers } from '@public/services/bom/priceBreaks';
import type { BomOffer, TableRow } from '@public/services/bom/types';
import type { FootprintPlacement } from '@public/services/kicad/boardPlacements';
import type { RefLocation } from '@public/services/kicad/schematicBom';

export interface PartCatalog {
  sku: string;
  /** `/part/<slug ?? id>` — the slug resolves and is the canonical form. */
  path: string;
  manufacturer: string | null;
  description: string | null;
  lifecycle: string | null;
  /** exact / approx / live, as the BOM table badges it; null for no match. */
  match: 'exact' | 'approx' | 'live' | null;
}

export interface PartPrice {
  unit: number;
  /** BOM quantity × build quantity — the quantity the unit price is read at. */
  lineQty: number;
  supplier: string;
  /** How many the supplier reports on the shelf. */
  stock: number;
}

export interface PartFacts {
  ref: string;
  /** True when ANY source knows this designator. */
  found: boolean;
  line: ParsedBomLine | null;
  /** The line's other designators, in the line's own order. */
  siblings: string[];
  sheet: string | null;
  instancePath: string | null;
  placement: FootprintPlacement | null;
  /** The value as the schematic states it, else as the board's footprint does. */
  value: string | null;
  /** The footprint as the schematic states it, else the board's library name. */
  footprint: string | null;
  mpn: string | null;
  /** Null until the BOM tab has priced this project, or when the line had no match. */
  catalog: PartCatalog | null;
  price: PartPrice | null;
  /** True when the BOM has been priced and this line is still waiting on a live lookup. */
  resolving: boolean;
  /** True when the workbench has answered for this project at all. */
  priced: boolean;
}

export interface PartSources {
  lines: readonly ParsedBomLine[];
  rows: readonly TableRow[];
  refs: ReadonlyMap<string, RefLocation>;
  placements: ReadonlyMap<string, FootprintPlacement> | null;
  buildQty: number;
}

/** The designator's own spelling in the project, for a search typed in any
 *  case: an exact hit first, else the one case-insensitive match. */
export function resolveRef(input: string, known: Iterable<string>): string | null {
  const wanted = input.trim();
  if (wanted === '') return null;
  const lower = wanted.toLowerCase();
  let loose: string | null = null;
  for (const ref of known) {
    if (ref === wanted) return ref;
    if (loose == null && ref.toLowerCase() === lower) loose = ref;
  }
  return loose;
}

/** Every designator the project names, once, in first-seen order. */
export function knownRefs(sources: Pick<PartSources, 'lines' | 'refs' | 'placements'>): string[] {
  const out = new Set<string>();
  for (const line of sources.lines) for (const ref of line.refs) out.add(ref);
  for (const ref of sources.refs.keys()) out.add(ref);
  if (sources.placements != null) for (const ref of sources.placements.keys()) out.add(ref);
  return [...out];
}

function matchOf(row: TableRow): PartCatalog['match'] {
  switch (row.server?.status) {
    case 'exact': return 'exact';
    case 'approx': return 'approx';
    case 'exact_live': return 'live';
    default: return null;
  }
}

function catalogOf(row: TableRow): PartCatalog | null {
  const part = row.server?.part ?? null;
  if (part == null) return null;
  return {
    sku: part.sku,
    path: `/part/${part.slug ?? part.id}`,
    manufacturer: part.manufacturer_name,
    description: part.description,
    lifecycle: part.lifecycle_status,
    match: matchOf(row),
  };
}

/** The BOM table's own rule, at the table's own quantity: `recommend` picks
 *  the offer, `priceAt` reads its ladder. Null when nothing is in stock. */
function priceOf(row: TableRow, buildQty: number): PartPrice | null {
  const offers: BomOffer[] = row.server?.offers ?? [];
  if (offers.length === 0) return null;
  const lineQty = Math.max(1, row.qty) * Math.max(1, buildQty);
  const id = recommend(offers, lineQty, tierRankFromOffers(offers));
  const chosen = id == null ? null : offers.find((o) => o.supplier_id === id) ?? null;
  if (chosen == null) return null;
  return { unit: priceAt(chosen, lineQty), lineQty, supplier: chosen.supplier_name, stock: chosen.stock_quantity };
}

export function partFacts(ref: string, sources: PartSources): PartFacts {
  const line = sources.lines.find((l) => l.refs.includes(ref)) ?? null;
  const row = line == null ? null : sources.rows.find((r) => r.index === line.index) ?? null;
  const where = sources.refs.get(ref) ?? null;
  const placement = sources.placements?.get(ref) ?? null;
  const found = line != null || where != null || placement != null;
  return {
    ref,
    found,
    line,
    siblings: line == null ? [] : line.refs.filter((r) => r !== ref),
    sheet: where?.sheet ?? null,
    instancePath: where?.instancePath ?? null,
    placement,
    value: line?.value ?? placement?.value ?? null,
    footprint: line?.footprint ?? placement?.lib ?? null,
    mpn: line?.mpn ?? null,
    catalog: row == null ? null : catalogOf(row),
    price: row == null ? null : priceOf(row, sources.buildQty),
    resolving: row?.state === 'resolving',
    priced: sources.rows.length > 0,
  };
}

/** `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm` → `SOIC-8_3.9x4.9mm_P1.27mm`: the part
 *  a reader recognises, without the library it came from. */
export function footprintName(footprint: string): string {
  const idx = footprint.indexOf(':');
  return idx >= 0 ? footprint.slice(idx + 1) : footprint;
}

/** Millimetres as the panel prints them: the file's precision is 1 µm at most,
 *  and three decimals is what KiCad's own status bar shows. */
export function formatMm(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, '');
}
