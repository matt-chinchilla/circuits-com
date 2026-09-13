// frontend/src/public/services/kicad/schematicBom.ts
// BOM lines read straight out of the schematic set (spec §4.3). One line per
// INSTANCE PATH, references resolved from the KiCad 7+ per-symbol `instances`
// block, else KiCad 6's root `symbol_instances` table, else the Reference
// property; power and not-in-BOM symbols skipped; grouped the way a grouped
// CSV export would be. `qty` is always the true instance count — the
// designator list is capped for display only.
import { MAX_LINES, MAX_REFS_PER_LINE, type ParsedBomLine, type ParseResult } from '@public/services/bom/parseBom';
import { matchHeader, type BomRole } from '@public/services/bom/headerAliases';
import { naturalRefCompare } from './naturalSort';
import { basename, resolveSheetRef } from './project';
import { atom, child, children, parse } from './sexpr';
import type { KicadProject, SExpr } from './types';

export interface RefLocation {
  sheet: string;
  instancePath: string;
}

export interface SchematicRead {
  result: ParseResult;
  refs: Map<string, RefLocation>;
  instances: number;
}

interface Instance {
  ref: string;
  mpn: string | null;
  manufacturer: string | null;
  distributorPn: string | null;
  value: string | null;
  footprint: string | null;
  description: string | null;
  dnp: boolean;
  sheet: string;
  instancePath: string;
}

const BUILTIN_PROPERTIES = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']);
const MAX_DEPTH = 32;
/** A DNP field is SET unless it says otherwise — exporters write "DNP", "1",
 *  "yes", "x" or the field's own name, but only a handful of explicit
 *  negatives. Matching the negatives is the only list that stays closed. */
const NOT_DNP = /^(no|false|0|n)$/i;

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  return v === '' || v === '~' ? null : v;
}

function properties(sym: SExpr[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of children(sym, 'property')) {
    const name = atom(p, 1);
    const value = atom(p, 2);
    if (name != null && value != null && !out.has(name)) out.set(name, value);
  }
  return out;
}

function powerSymbols(doc: SExpr[]): Set<string> {
  const out = new Set<string>();
  const lib = child(doc, 'lib_symbols');
  if (lib == null) return out;
  for (const s of children(lib, 'symbol')) {
    const name = atom(s, 1);
    if (name != null && child(s, 'power') != null) out.add(name);
  }
  return out;
}

function symbolInstancesTable(doc: SExpr[]): Map<string, string> {
  const out = new Map<string, string>();
  const table = child(doc, 'symbol_instances');
  if (table == null) return out;
  for (const p of children(table, 'path')) {
    const path = atom(p, 1);
    const ref = atom(child(p, 'reference') ?? [], 1);
    if (path != null && ref != null) out.set(path.toLowerCase(), ref);
  }
  return out;
}

function referenceFromInstances(sym: SExpr[], instancePath: string): string | null {
  const inst = child(sym, 'instances');
  if (inst == null) return null;
  for (const project of children(inst, 'project')) {
    for (const p of children(project, 'path')) {
      if ((atom(p, 1) ?? '').toLowerCase() === instancePath.toLowerCase()) return atom(child(p, 'reference') ?? [], 1);
    }
  }
  return null;
}

function emptyResult(error: string | null): ParseResult {
  return { lines: [], headers: [], headerSignature: 'kicad-sch', roleByColumn: [], unmappedColumns: [], warnings: [], error };
}

export function readSchematic(project: KicadProject): SchematicRead {
  const warnings: string[] = [];
  const refs = new Map<string, RefLocation>();
  if (project.root == null || project.sheets.length === 0) {
    return { result: emptyResult('No schematic in this project — drop the .kicad_sch files to read a BOM.'), refs, instances: 0 };
  }

  const docs = new Map<string, SExpr[]>();
  for (const s of project.sheets) {
    try {
      const doc = parse(s.text)[0];
      if (Array.isArray(doc)) docs.set(s.path, doc);
    } catch (err) {
      warnings.push(`${basename(s.path)} could not be read (${err instanceof Error ? err.message : 'parse error'}) and was skipped.`);
    }
  }
  const rootDoc = docs.get(project.root);
  if (rootDoc == null) return { result: emptyResult('The root schematic could not be read.'), refs, instances: 0 };

  const rootUuid = project.sheets[0]?.uuid ?? '';
  const legacy = symbolInstancesTable(rootDoc);
  const instances: Instance[] = [];
  const seen = new Set<string>();
  const propertySheets = new Set<string>();
  const selfReferencing = new Set<string>();
  let skippedNotInBom = 0;
  let skippedUnusable = 0;
  let unannotated = 0;

  const visit = (sheetPath: string, sheetUuids: string[], depth: number, chain: string[]): void => {
    const doc = docs.get(sheetPath);
    if (doc == null) return;
    if (depth > MAX_DEPTH) return;
    const power = powerSymbols(doc);
    const pathV7 = `/${[rootUuid, ...sheetUuids].join('/')}`;
    const pathV6 = sheetUuids.length === 0 ? '' : `/${sheetUuids.join('/')}`;
    for (const sym of children(doc, 'symbol')) {
      const libId = atom(child(sym, 'lib_id') ?? [], 1);
      if (libId == null) continue;
      if (atom(child(sym, 'in_bom') ?? [], 1) === 'no') {
        skippedNotInBom++;
        continue;
      }
      const props = properties(sym);
      const uuid = (atom(child(sym, 'uuid') ?? [], 1) ?? '').toLowerCase();
      // An instance table names this symbol AT THIS PATH; the Reference
      // property is a per-file cache that cannot distinguish two placements.
      const tabled = referenceFromInstances(sym, pathV7) ?? legacy.get(`${pathV6}/${uuid}`.toLowerCase()) ?? null;
      const ref = tabled ?? clean(props.get('Reference'));
      if (ref == null || ref.startsWith('#') || power.has(libId)) {
        skippedUnusable++;
        continue;
      }
      // A reference designator names ONE physical part for the whole
      // hierarchy, so the dedupe is designator-scoped, not path-scoped: a
      // multi-unit symbol may draw its units on DIFFERENT sheets (Glasgow's
      // U30 is a 5-unit FPGA with units 3+5 on the root and 1, 2+4 on
      // io_banks) and a path-scoped key buys that chip twice. A sheet placed
      // twice is re-annotated by KiCad, so its two placements still arrive
      // here as two distinct designators.
      //
      // Two inputs cannot support that reasoning and must never merge:
      //   - an UNANNOTATED symbol, where every part answers "R?" — keyed by
      //     the symbol's own uuid (path-qualified, so a twice-placed sheet
      //     still counts twice);
      //   - a reference that came from the PROPERTY FALLBACK, where both
      //     placements of a sheet read the same cached string — keyed by the
      //     instance path, so the second placement is counted rather than
      //     silently swallowed (an under-count ships too few parts).
      const isUnannotated = ref.endsWith('?');
      if (tabled == null) propertySheets.add(sheetPath);
      const key = isUnannotated
        ? `${pathV7}|${uuid === '' ? `#${instances.length}` : uuid}`
        : tabled == null
          ? `${pathV7}|${ref}`
          : ref;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isUnannotated) unannotated++;
      let mpn: string | null = null;
      let manufacturer: string | null = null;
      let distributorPn: string | null = null;
      let dnpField = false;
      for (const [name, value] of props) {
        if (BUILTIN_PROPERTIES.has(name)) continue;
        const role: BomRole | null = matchHeader(name);
        const v = clean(value);
        if (v == null) continue;
        if (role === 'mpn' && mpn == null) mpn = v;
        else if (role === 'manufacturer' && manufacturer == null) manufacturer = v;
        else if (role === 'distributor_pn' && distributorPn == null) distributorPn = v;
        // A DNP FIELD marks the part, not only the `(dnp yes)` attribute:
        // Glasgow writes `(dnp no)` on all 347 symbols and flags its
        // do-not-populate parts with `(property "DNP" "DNP")` alone. Anything
        // that is not an explicit negative counts as set, the way a CSV DNP
        // column is read.
        else if (role === 'dnp' && !NOT_DNP.test(v)) dnpField = true;
      }
      instances.push({
        ref, mpn, manufacturer, distributorPn,
        value: clean(props.get('Value')),
        footprint: clean(props.get('Footprint')),
        description: clean(props.get('Description')),
        dnp: dnpField || atom(child(sym, 'dnp') ?? [], 1) === 'yes',
        sheet: sheetPath,
        instancePath: pathV7,
      });
      refs.set(ref, { sheet: sheetPath, instancePath: pathV7 });
    }
    // Re-entering a sheet is CORRECT — that is how a twice-placed sheet gets
    // counted twice — so the guard is the ancestor chain, not a visited set.
    // A sheet that references itself (directly or through a cycle) would
    // otherwise expand 2^MAX_DEPTH times and hang the tab; KiCad refuses
    // recursive hierarchies, so skipping is also what the file means.
    const nextChain = [...chain, sheetPath];
    for (const sh of children(doc, 'sheet')) {
      const uuid = (atom(child(sh, 'uuid') ?? [], 1) ?? '').toLowerCase();
      const file = properties(sh).get('Sheetfile');
      if (uuid === '' || file == null) continue;
      const r = resolveSheetRef(sheetPath, file, docs.keys());
      if ('missing' in r) continue;
      if (nextChain.includes(r.path)) {
        selfReferencing.add(r.path);
        continue;
      }
      visit(r.path, [...sheetUuids, uuid], depth + 1, nextChain);
    }
  };
  visit(project.root, [], 0, []);

  const skipped = skippedNotInBom + skippedUnusable;
  if (skipped > 0) warnings.push(`${skipped} symbols skipped: ${skippedNotInBom} not in BOM, ${skippedUnusable} power, virtual or unreferenced.`);
  for (const path of selfReferencing) warnings.push(`${basename(path)} references itself (directly or through its sub-sheets); that reference was skipped.`);
  for (const path of propertySheets) warnings.push(`${basename(path)}: references were read from symbol properties, not instance tables — a sheet placed more than once may show duplicate designators.`);
  if (unannotated > 0) warnings.push(`${unannotated} symbols are not annotated (R?, U? …); run Tools → Annotate Schematic in KiCad for an accurate BOM.`);
  if (project.missingSheets.length > 0) warnings.push(`Parts on the missing sheet(s) ${project.missingSheets.join(', ')} are not in this BOM.`);

  const groups = new Map<string, Instance[]>();
  for (const inst of instances) {
    const key = [inst.mpn, inst.manufacturer, inst.value, inst.footprint, inst.dnp ? 'dnp' : ''].map((v) => v ?? '').join('\u0000');
    const bucket = groups.get(key);
    if (bucket) bucket.push(inst);
    else groups.set(key, [inst]);
  }

  const lines: ParsedBomLine[] = [];
  // 1-based, like the CSV path (`parseBom` assigns `i + 1`) — `BomTable`
  // renders this as the visible line number and `share.ts` round-trips it.
  let index = 1;
  for (const bucket of groups.values()) {
    const first = bucket[0] as Instance;
    const sorted = bucket.map((i) => i.ref).sort(naturalRefCompare);
    if (sorted.length > MAX_REFS_PER_LINE) {
      warnings.push(`${sorted[0]} and ${sorted.length - 1} more: ${sorted.length} instances, showing the first ${MAX_REFS_PER_LINE} designators — the quantity is still ${sorted.length}.`);
    }
    lines.push({
      index: index++,
      mpn: first.mpn,
      value: first.value,
      footprint: first.footprint,
      description: first.description,
      manufacturer: first.manufacturer,
      distributorPn: first.distributorPn,
      qty: bucket.length,
      refs: sorted.slice(0, MAX_REFS_PER_LINE),
      dnp: first.dnp,
    });
  }

  const roles: BomRole[] = ['refs', 'qty', 'value', 'footprint', 'description', 'dnp'];
  const labels: Record<BomRole, string> = {
    refs: 'Reference', qty: 'Qty', value: 'Value', footprint: 'Footprint', description: 'Description', dnp: 'DNP',
    mpn: 'MPN', manufacturer: 'Manufacturer', distributor_pn: 'Distributor P/N', datasheet: 'Datasheet',
  };
  if (lines.some((l) => l.mpn != null)) roles.push('mpn');
  if (lines.some((l) => l.manufacturer != null)) roles.push('manufacturer');
  if (lines.some((l) => l.distributorPn != null)) roles.push('distributor_pn');

  const error = lines.length > MAX_LINES
    ? `That schematic has ${lines.length.toLocaleString('en-US')} BOM lines; the tool reads up to ${MAX_LINES.toLocaleString('en-US')}.`
    : null;

  return {
    result: {
      lines: error == null ? lines : [],
      headers: roles.map((r) => labels[r]),
      headerSignature: 'kicad-sch',
      roleByColumn: roles,
      unmappedColumns: [],
      warnings,
      error,
    },
    refs,
    instances: instances.length,
  };
}

export function readBomLines(project: KicadProject): ParseResult {
  return readSchematic(project).result;
}
