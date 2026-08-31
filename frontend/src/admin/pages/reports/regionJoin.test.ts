import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Admin1Collection, Admin1Feature } from '@admin/components/charts/admin1';
import {
  buildRegionIndex,
  matchRegion,
  normalizeRegionName,
  resolveRegions,
} from './regionJoin';
import { OBSERVED_REGIONS } from './observedRegions';

// ── Two halves ──────────────────────────────────────────────────────────────
// The first half is the RULE, on hand-built features: what each step does and,
// as importantly, what it refuses to do.
//
// The second half is the COVERAGE MEASUREMENT: the shipped rule run over every
// (country, region) pair the production database has actually recorded,
// against the committed Natural Earth assets. It pins the number AND names the
// eight that still find no polygon, so "94% coverage" is a fact this suite
// re-derives rather than a claim in a commit message.

const feature = (properties: Admin1Feature['properties']): Admin1Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [] },
});

describe('normalizeRegionName', () => {
  it('casefolds, strips diacritics and collapses punctuation', () => {
    expect(normalizeRegionName('Île-de-France')).toBe('ile de france');
    expect(normalizeRegionName('São Paulo')).toBe('sao paulo');
    expect(normalizeRegionName("Provence-Alpes-Côte d'Azur")).toBe('provence alpes cote d azur');
  });

  it('is total over the nullable payload field', () => {
    expect(normalizeRegionName(null)).toBe('');
    expect(normalizeRegionName(undefined)).toBe('');
    expect(normalizeRegionName('   ')).toBe('');
  });

  it('reduces a name with no Latin letters to nothing rather than a key', () => {
    // Natural Earth carries local-script aliases; they must not become index
    // keys that a Latin query could never reach but a blank one could.
    expect(normalizeRegionName('北京')).toBe('');
  });
});

describe('matchRegion', () => {
  const index = buildRegionIndex([
    feature({ name: 'Bavaria', code: 'DE-BY', alt: ['Bayern', 'Freistaat Bayern'] }),
    feature({ name: 'Berlin', code: 'DE-BE' }),
    feature({ name: 'Rome', code: 'IT-RM', in: ['Lazio'] }),
    feature({ name: 'Latina', code: 'IT-LT', in: ['Lazio'] }),
    feature({ name: 'Palawan', in: ['MIMAROPA (Region IV-B)'] }),
    feature({ name: 'Federal Capital Territory', code: 'NG-FC', alt: ['Abuja'] }),
  ]);

  it('matches an exact name', () => {
    expect(matchRegion(index, 'Bavaria')).toEqual({ features: ['Bavaria'], kind: 'name' });
  });

  it('matches an alias', () => {
    expect(matchRegion(index, 'Bayern')?.features).toEqual(['Bavaria']);
  });

  it('matches the ISO code suffix', () => {
    expect(matchRegion(index, 'BY')?.features).toEqual(['Bavaria']);
  });

  it('strips a leading qualifier only after the exact lookup fails', () => {
    const match = matchRegion(index, 'State of Berlin');
    expect(match).toEqual({ features: ['Berlin'], kind: 'qualifier' });
  });

  it('strips a trailing qualifier', () => {
    const county = buildRegionIndex([feature({ name: 'Nairobi' })]);
    expect(matchRegion(county, 'Nairobi County')).toEqual({
      features: ['Nairobi'],
      kind: 'qualifier',
    });
  });

  it('prefers the exact name over the stripped one', () => {
    // Belarus really does ship both: "Minsk" the oblast and "Minsk City".
    // A query naming the city must not be rewritten into the oblast when the
    // city itself is right there.
    const belarus = buildRegionIndex([feature({ name: 'Minsk City' }), feature({ name: 'Minsk' })]);
    expect(matchRegion(belarus, 'Minsk City')).toEqual({
      features: ['Minsk City'],
      kind: 'name',
    });
  });

  it('falls back to the coarser grouping, returning every member', () => {
    expect(matchRegion(index, 'Lazio')).toEqual({
      features: ['Rome', 'Latina'],
      kind: 'group',
    });
  });

  it('reads a grouping past its parenthetical administrative code', () => {
    expect(matchRegion(index, 'Mimaropa')?.features).toEqual(['Palawan']);
  });

  it('accepts an acronym only when it names exactly one subdivision', () => {
    expect(matchRegion(index, 'FCT')).toEqual({
      features: ['Federal Capital Territory'],
      kind: 'acronym',
    });
    const ambiguous = buildRegionIndex([
      feature({ name: 'North Region' }),
      feature({ name: 'Nord Rhein' }),
    ]);
    expect(matchRegion(ambiguous, 'NR')).toBeNull();
  });

  it('returns null rather than guessing at a near miss', () => {
    // Both are real: Natural Earth says "Ashkhabad" where DB-IP says
    // "Ashgabat", and "Masovian" where DB-IP says "Mazovia". An edit-distance
    // fallback that caught these would also catch their neighbours, and a
    // choropleth painting the wrong province is a lie a reader cannot see.
    expect(matchRegion(index, 'Ashgabat')).toBeNull();
    expect(matchRegion(index, 'Mazovia')).toBeNull();
  });

  it('returns null for an empty or unnameable region', () => {
    expect(matchRegion(index, '')).toBeNull();
    expect(matchRegion(index, '  ')).toBeNull();
  });
});

describe('resolveRegions', () => {
  const index = buildRegionIndex([
    feature({ name: 'Rome', in: ['Lazio'] }),
    feature({ name: 'Latina', in: ['Lazio'] }),
    feature({ name: 'Naples', in: ['Campania'] }),
  ]);

  it('maps every painted feature back to the row that owns it', () => {
    const rows = [
      { name: 'Lazio', views: 9, visitors: 5 },
      { name: 'Campania', views: 2, visitors: 2 },
    ];
    const { owners, featuresByRegion, unmatched } = resolveRegions(index, rows);
    expect([...owners.keys()]).toEqual(['Rome', 'Latina', 'Naples']);
    expect(owners.get('Latina')).toBe(rows[0]);
    expect(featuresByRegion.get('Lazio')).toEqual(['Rome', 'Latina']);
    expect(unmatched).toEqual([]);
  });

  it('hands back the rows it could not place instead of dropping them', () => {
    // They are real visits and still belong in the rank rail.
    const rows = [{ name: 'Sicilia', views: 4, visitors: 4 }];
    const { owners, unmatched } = resolveRegions(index, rows);
    expect(owners.size).toBe(0);
    expect(unmatched).toEqual(rows);
  });

  it('gives a contested feature to the busier row and does not paint it twice', () => {
    // Natural Earth lists Belarus' city and oblast under one `name`; two rows
    // reaching for it must not leave the map disagreeing with the rail.
    const belarus = buildRegionIndex([feature({ name: 'Minsk', alt: ['Minsk Oblast'] })]);
    const rows = [
      { name: 'Minsk City', views: 30, visitors: 20 },
      { name: 'Minsk Oblast', views: 3, visitors: 2 },
    ];
    const { owners, unmatched } = resolveRegions(belarus, rows);
    expect(owners.get('Minsk')).toBe(rows[0]);
    expect(unmatched).toEqual([rows[1]]);
  });

  it('is stable for an empty payload', () => {
    const { owners, featuresByRegion, unmatched } = resolveRegions(index, []);
    expect([owners.size, featuresByRegion.size, unmatched.length]).toEqual([0, 0, 0]);
  });
});

// ── The coverage measurement ────────────────────────────────────────────────

const ASSET_DIR = fileURLToPath(new URL('../../components/charts/admin1/', import.meta.url));

function loadAsset(code: string): Admin1Collection | null {
  try {
    return JSON.parse(readFileSync(`${ASSET_DIR}${code}.geo.json`, 'utf8')) as Admin1Collection;
  } catch {
    return null;
  }
}

/** Every real pair, resolved. `null` shape = no polygon for that name. */
function measureCoverage() {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const kinds: Record<string, number> = {};
  let noAsset = 0;

  for (const [code, rows] of Object.entries(OBSERVED_REGIONS)) {
    if (code === 'US') continue; // its own pre-projected asset; measured below
    const asset = loadAsset(code);
    if (!asset) {
      noAsset += rows.length;
      for (const [name] of rows) unmatched.push(`${code} ${name}`);
      continue;
    }
    const index = buildRegionIndex(asset.features);
    for (const [name] of rows) {
      const match = matchRegion(index, name);
      if (match) {
        matched.push(`${code} ${name}`);
        kinds[match.kind] = (kinds[match.kind] ?? 0) + 1;
      } else {
        unmatched.push(`${code} ${name}`);
      }
    }
  }
  return { matched, unmatched, kinds, noAsset };
}

describe('coverage over the regions production has actually recorded', () => {
  const result = measureCoverage();
  const total = result.matched.length + result.unmatched.length;

  it('has an admin-1 asset for every country that has sent a located visit', () => {
    expect(result.noAsset).toBe(0);
  });

  it('names the regions that still have no polygon, and only those', () => {
    // Each of the eight is a real disagreement between the two datasets, and
    // each is a deliberate non-match rather than a bug to fix with a looser
    // rule (see the header of regionJoin.ts):
    //   BE Wallonia               Natural Earth says "Walloon Region"
    //   CI Abidjan Autonomous...  NE still carries the pre-2011 régions
    //   IE Leinster               NE groups Irish counties by NUTS3, not by
    //                             the four historical provinces
    //   LK Western / Western Province / Central Province
    //                             NE labels Sri Lanka's provinces in
    //                             transliterated Sinhala ("Basnahira palata")
    //   PL Mazovia                NE says "Masovian" / "Mazowieckie"
    //   TM Ashgabat               NE says "Ashkhabad", and the city is folded
    //                             into Ahal province
    expect(result.unmatched.sort()).toEqual([
      'BE Wallonia',
      'CI Abidjan Autonomous District',
      'IE Leinster',
      'LK Central Province',
      'LK Western',
      'LK Western Province',
      'PL Mazovia',
      'TM Ashgabat',
    ]);
  });

  it('resolves 107 of the 115 non-US pairs', () => {
    expect([result.matched.length, total]).toEqual([107, 115]);
  });

  it('leans on exact names, with the fallbacks carrying the tail', () => {
    // If this ever inverts — most matches arriving through a fallback — the
    // fallbacks have stopped being a tail and started being the rule, which
    // is the point at which they need re-justifying.
    expect(result.kinds).toEqual({ name: 89, qualifier: 4, group: 13, acronym: 1 });
  });
});

describe('the United States keeps its own asset, and it needs no join', () => {
  it('every recorded US region is an exact feature name in the albers file', () => {
    const albers = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../components/charts/us-states-albers.geo.json', import.meta.url)),
        'utf8',
      ),
    ) as { features: Array<{ properties: { name: string } }> };
    const names = new Set(albers.features.map((f) => f.properties.name));
    const missing = (OBSERVED_REGIONS.US ?? []).map(([name]) => name).filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  it('is absent from the admin-1 directory, so nothing can load it by mistake', () => {
    expect(loadAsset('US')).toBeNull();
  });
});
