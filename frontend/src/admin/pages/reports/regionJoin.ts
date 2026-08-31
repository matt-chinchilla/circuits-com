// Joining DB-IP subdivision names to Natural Earth admin-1 polygons.
//
// This is the hard part of drilling into a country, and it is hard because
// the two sides are different datasets that merely agree about geography:
//
//   DB-IP  writes ONE English label per page view — "Bavaria", "State of
//          Berlin", "Île-de-France", "Oyo State", "Kwai Tsing District",
//          "FCT" — at ISO 3166-2 FIRST level.
//   Natural Earth ships `name`, `name_en`, `name_alt`, `iso_3166_2`, plus the
//          coarser `region`/`geonunit` groupings, at ITS OWN admin-1 level,
//          which for several countries is a level BELOW ISO's first (Italy is
//          110 provinces, not 20 regions; the United Kingdom is 231 districts,
//          not 4 countries).
//
// So a match is one-to-MANY by nature, and the answer is a SET of polygons.
//
// ── The rule, in order, and why each step is here ──────────────────────────
// Every step below earned its place from the live database (measured
// 2026-08-30 over all 144 real (country, region) pairs; the counts are in
// regionJoin.test.ts, which pins the real cases INCLUDING the ones that
// still fail):
//
//   1. exact, on the normalized name / any alias / the ISO code's own suffix
//      — 89 of 115 non-US pairs.
//   2. exact after ONE qualifier strip — 4 pairs. "State of Berlin" vs
//      "Berlin", "Nairobi County" vs "Nairobi", "Kwai Tsing District" vs
//      "Kwai Tsing", "Minsk City" vs "Minsk". The strip list is closed and
//      short on purpose: a loose rewrite paints the WRONG polygon, which is
//      worse than painting none.
//   3. the coarser grouping — 13 pairs, and the only way "England", "Lazio",
//      "Île-de-France", "Kowloon" or "Mimaropa" can resolve at all.
//   4. a unique acronym — 1 pair ("FCT" -> Federal Capital Territory). Guarded
//      on uniqueness: an acronym matching two subdivisions matches neither.
//
// Nothing fuzzy, ever. "Ashgabat" is one edit away from Natural Earth's
// "Ashkhabad" and "Mazovia" is close to "Masovian", but a transliteration
// distance that catches those also catches neighbours, and a choropleth that
// paints the wrong province is a lie a reader cannot see. Those stay
// unmatched, which the panel renders honestly: the region keeps its row and
// its numbers in the rank rail and simply has no shape.

import type { Admin1Feature } from '@admin/components/charts/admin1';

/** Casefold, strip diacritics, reduce everything else to single spaces.
 *  "Île-de-France" and "ile de france" are the same key; "São Paulo" and
 *  "Sao Paulo" are too. NFD first so the combining marks are separable. */
export function normalizeRegionName(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The qualifier words a subdivision name may carry on one side and not the
 *  other. Applied ONCE, to the DB-IP name only, and only after every exact
 *  lookup has already failed. */
// Deliberately NOT "district of" or "city of": neither is justified by any
// observed pair, and "district of" alone would rewrite "District of Columbia"
// into "columbia".
const LEADING_QUALIFIER = /^(?:state|province|region|governorate) of /;
const TRAILING_QUALIFIER =
  / (?:state|province|region|governorate|district|county|city|division|prefecture|municipality|territory)$/;

/** How a region found its polygons. Reported so the coverage measurement is
 *  reproducible from the code rather than from a spreadsheet. */
export type RegionMatchKind = 'name' | 'qualifier' | 'group' | 'acronym';

export interface RegionMatch {
  /** `properties.name` of every feature to paint, in asset order. */
  features: string[];
  kind: RegionMatchKind;
}

export interface RegionIndex {
  /** normalized name / alias / ISO code suffix -> feature names */
  byName: ReadonlyMap<string, string[]>;
  /** normalized coarser grouping -> feature names */
  byGroup: ReadonlyMap<string, string[]>;
  /** initials of a feature's name or alias -> feature names */
  byAcronym: ReadonlyMap<string, string[]>;
}

function push(index: Map<string, string[]>, key: string, name: string): void {
  if (!key) return;
  const bucket = index.get(key);
  if (!bucket) index.set(key, [name]);
  else if (!bucket.includes(name)) bucket.push(name);
}

function initials(normalized: string): string {
  return normalized
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .join('');
}

/** Build the lookup tables for ONE country's features. Pure; call it once per
 *  loaded asset and reuse it for every region row. */
export function buildRegionIndex(features: readonly Admin1Feature[]): RegionIndex {
  const byName = new Map<string, string[]>();
  const byGroup = new Map<string, string[]>();
  const byAcronym = new Map<string, string[]>();

  for (const feature of features) {
    const { name, code, alt, in: groups } = feature.properties;
    if (!name) continue;

    for (const spelling of [name, ...(alt ?? [])]) {
      const key = normalizeRegionName(spelling);
      push(byName, key, name);
      const acronym = initials(key);
      if (acronym.length >= 2) push(byAcronym, acronym, name);
    }
    // "DE-BY" -> "by". DB-IP writes names, not codes, but the suffix is free
    // to index and it is what would catch a payload that ever carried one.
    if (code) push(byName, normalizeRegionName(code.slice(code.indexOf('-') + 1)), name);

    for (const group of groups ?? []) {
      push(byGroup, normalizeRegionName(group), name);
      // Natural Earth labels several groupings with a parenthetical
      // administrative code — "MIMAROPA (Region IV-B)" — that DB-IP never
      // carries. Index the bare form beside the full one.
      const bare = normalizeRegionName(group.replace(/\s*\([^)]*\)\s*$/, ''));
      if (bare) push(byGroup, bare, name);
    }
  }

  return { byName, byGroup, byAcronym };
}

/** The polygons for one DB-IP subdivision name, or null when this country's
 *  asset has no shape for it. */
export function matchRegion(index: RegionIndex, regionName: string): RegionMatch | null {
  const exact = normalizeRegionName(regionName);
  if (!exact) return null;

  const stripped = exact.replace(LEADING_QUALIFIER, '').replace(TRAILING_QUALIFIER, '').trim();
  const hasStrip = stripped.length > 0 && stripped !== exact;

  const direct = index.byName.get(exact);
  if (direct) return { features: direct, kind: 'name' };

  if (hasStrip) {
    const viaStrip = index.byName.get(stripped);
    if (viaStrip) return { features: viaStrip, kind: 'qualifier' };
  }

  const group = index.byGroup.get(exact) ?? (hasStrip ? index.byGroup.get(stripped) : undefined);
  if (group) return { features: group, kind: 'group' };

  // Uniqueness is the guard: "FCT" naming exactly one subdivision is a
  // match; an initialism that fits two is not a match at all.
  const acronym = index.byAcronym.get(exact);
  if (acronym && acronym.length === 1) return { features: acronym, kind: 'acronym' };

  return null;
}

/** One row of the API's `regions` array — name, and the numbers behind it. */
export interface RegionRow {
  name: string;
  views: number;
  visitors: number;
}

export interface ResolvedRegions<T extends RegionRow> {
  /** feature name -> the row that owns it. This is what the choropleth
   *  paints and what the tooltip reads. */
  owners: Map<string, T>;
  /** region name -> its feature names, for the click-to-zoom fit. */
  featuresByRegion: Map<string, string[]>;
  /** Rows this country's asset has no shape for. They still belong in the
   *  rank rail — they are real visits — so they are handed back rather than
   *  dropped. */
  unmatched: T[];
}

/**
 * Resolve a whole `regions` payload against one country's index.
 *
 * Rows are expected busiest-first (the API orders them that way), and a
 * feature claimed by two rows stays with the FIRST — the busier one. That
 * collision is real: Natural Earth lists Belarus' city of Minsk and Minsk
 * oblast under the same `name`, so "Minsk City" and a future "Minsk Region"
 * would both reach for it. Painting it once, for the busier row, keeps the
 * choropleth's colors and the rank rail's numbers describing the same thing.
 */
export function resolveRegions<T extends RegionRow>(
  index: RegionIndex,
  rows: readonly T[],
): ResolvedRegions<T> {
  const owners = new Map<string, T>();
  const featuresByRegion = new Map<string, string[]>();
  const unmatched: T[] = [];

  for (const row of rows) {
    const match = matchRegion(index, row.name);
    if (!match) {
      unmatched.push(row);
      continue;
    }
    const claimed = match.features.filter((feature) => !owners.has(feature));
    if (!claimed.length) {
      unmatched.push(row);
      continue;
    }
    for (const feature of claimed) owners.set(feature, row);
    featuresByRegion.set(row.name, claimed);
  }

  return { owners, featuresByRegion, unmatched };
}
