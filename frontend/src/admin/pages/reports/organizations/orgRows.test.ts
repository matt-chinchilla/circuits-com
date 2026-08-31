import { describe, it, expect } from 'vitest';
import type { OrgKind, VisitorOrganization } from '@admin/services/adminApi';
import {
  FILTER_LABEL,
  ORG_FILTERS,
  emptyMessage,
  filterCount,
  filterOrganizations,
  matchBadge,
  locationLabel,
  locationSummary,
  visitorLine,
} from './orgRows';

function org(name: string, kind: OrgKind, extra: Partial<VisitorOrganization> = {}): VisitorOrganization {
  return {
    name,
    kind,
    views: 1,
    visitors: 1,
    first_seen: null,
    last_seen: null,
    locations: [],
    top_pages: [],
    referrers: [],
    devices: [],
    ...extra,
  };
}

const ROWS = [
  org('Cirrus Logic Inc.', 'corporate'),
  org('Sachem Central School District', 'corporate'),
  org('Verizon Business', 'isp'),
  org('Hetzner Online GmbH', 'hosting'),
];

describe('filterOrganizations', () => {
  it('keeps only the chosen kind', () => {
    expect(filterOrganizations(ROWS, 'corporate').map((o) => o.name)).toEqual([
      'Cirrus Logic Inc.',
      'Sachem Central School District',
    ]);
    expect(filterOrganizations(ROWS, 'isp').map((o) => o.name)).toEqual(['Verizon Business']);
  });

  it('passes everything through under "all", in the server\'s order', () => {
    expect(filterOrganizations(ROWS, 'all')).toEqual(ROWS);
  });

  it('never reorders — the server sorted by distinct visitors', () => {
    const busy = [org('Quiet Corp', 'corporate', { visitors: 1 }), org('Busy Corp', 'corporate', { visitors: 9 })];
    expect(filterOrganizations(busy, 'corporate').map((o) => o.name)).toEqual([
      'Quiet Corp',
      'Busy Corp',
    ]);
  });
});

describe('filterCount', () => {
  const counts = { corporate: 50, isp: 80, hosting: 47, matched: 12 };

  it('reads the matching count', () => {
    expect(filterCount(counts, 'corporate')).toBe(50);
    expect(filterCount(counts, 'hosting')).toBe(47);
  });

  it('derives "all" by summing, because the three partition the list', () => {
    expect(filterCount(counts, 'all')).toBe(177);
  });

  it('has a label for every chip it can be asked about', () => {
    for (const key of ORG_FILTERS) {
      expect(FILTER_LABEL[key]).toBeTruthy();
      expect(filterCount(counts, key)).toBeGreaterThan(0);
    }
  });

  it('never folds the matched count into the total — it OVERLAPS the kinds', () => {
    // A matched organization is also corporate/isp/hosting, so adding it in
    // would double-count it and make "All" disagree with the row count.
    expect(filterCount(counts, 'all')).toBe(177);
    expect(filterCount(counts, 'matched')).toBe(12);
  });
});

describe('locationLabel', () => {
  const loc = (city: string | null, region: string | null, country: string | null) => ({
    city,
    region,
    country,
    views: 1,
  });

  it('names the place as precisely as the row knows it', () => {
    expect(locationLabel(loc('Austin', 'Texas', 'US'))).toBe('Austin, Texas');
  });

  it('drops a dangling comma when the region is missing', () => {
    expect(locationLabel(loc('Austin', null, 'US'))).toBe('Austin');
  });

  it('falls back to the country NAME when there is no city at all', () => {
    // Pre-048 history and country-lite lookups both look like this.
    expect(locationLabel(loc(null, null, 'DE'))).toBe('Germany');
  });

  it('does not append the country to a city — that is noise, not detail', () => {
    expect(locationLabel(loc('Austin', 'Texas', 'US'))).not.toContain('United States');
  });

  it('returns null when the row knows no place, so the caller drops the line', () => {
    expect(locationLabel(loc(null, null, null))).toBeNull();
  });
});

describe('locationSummary', () => {
  const loc = (city: string, region: string) => ({ city, region, country: 'US', views: 1 });

  it('is just the busiest place when there is one', () => {
    expect(locationSummary([loc('Austin', 'Texas')])).toBe('Austin, Texas');
  });

  it('counts the rest so a multi-site company does not read as one office', () => {
    expect(locationSummary([loc('Austin', 'Texas'), loc('Dallas', 'Texas')])).toBe(
      'Austin, Texas +1 more',
    );
  });

  it('is null with nothing to say', () => {
    expect(locationSummary([])).toBeNull();
    expect(locationSummary([{ city: null, region: null, country: null, views: 3 }])).toBeNull();
  });
});

describe('visitorLine', () => {
  it('leads with visitors — the sort key, and the count of PEOPLE', () => {
    expect(visitorLine({ visitors: 18, views: 215 })).toBe('18 visitors · 215 views');
  });

  it('singularises both halves independently', () => {
    expect(visitorLine({ visitors: 1, views: 1 })).toBe('1 visitor · 1 view');
    expect(visitorLine({ visitors: 1, views: 4 })).toBe('1 visitor · 4 views');
  });
});

describe('emptyMessage', () => {
  const none = { corporate: 0, isp: 0, hosting: 0, matched: 0 };

  it('says capture has not started when no network has ever resolved', () => {
    const text = emptyMessage('corporate', none, null);
    expect(text).toContain('2026-08-30');
  });

  it('says the WINDOW is empty when capture has started but nothing landed', () => {
    const text = emptyMessage('corporate', none, '2026-08-30 12:00:00+00:00');
    expect(text).toContain('this window');
    expect(text).not.toContain('2026-08-30');
  });

  it('never claims nobody visited when the traffic is simply in another bucket', () => {
    // The failure this exists to prevent: a busy week of ISP and hosting
    // traffic reading as "no visitors" because the default chip is Companies.
    const text = emptyMessage('corporate', { corporate: 0, isp: 80, hosting: 47, matched: 0 }, '2026-08-30');
    expect(text).toContain('127 organizations');
    expect(text).toContain('companies');
  });
});

describe('matched rows', () => {
  const org = (name: string, kind: 'corporate' | 'isp', match: { kind: string; name: string } | null) =>
    ({
      name,
      kind,
      match: match ? { ...match, id: 'id-' + name } : null,
      views: 1,
      visitors: 1,
      first_seen: null,
      last_seen: null,
      locations: [],
      top_pages: [],
      referrers: [],
      devices: [],
    }) as unknown as Parameters<typeof filterOrganizations>[0][number];

  const rows = [
    org('Verizon Business', 'isp', null),
    org('Cirrus Logic Inc.', 'corporate', { kind: 'manufacturer', name: 'Cirrus Logic Inc.' }),
    org('Some Startup LLC', 'corporate', null),
    org('Club Car, LLC', 'corporate', { kind: 'lead', name: 'Club Car, LLC' }),
  ];

  it('the matched chip shows only organizations we already know', () => {
    expect(filterOrganizations(rows, 'matched').map((o) => o.name)).toEqual([
      'Cirrus Logic Inc.',
      'Club Car, LLC',
    ]);
  });

  it('floats matched rows to the top of every other view', () => {
    expect(filterOrganizations(rows, 'all').map((o) => o.name)).toEqual([
      'Cirrus Logic Inc.',
      'Club Car, LLC',
      'Verizon Business',
      'Some Startup LLC',
    ]);
    expect(filterOrganizations(rows, 'corporate').map((o) => o.name)).toEqual([
      'Cirrus Logic Inc.',
      'Club Car, LLC',
      'Some Startup LLC',
    ]);
  });

  it('names the source of the match, and stays open to new ones', () => {
    expect(matchBadge('lead')).toBe('In your leads');
    expect(matchBadge('manufacturer')).toBe('Tracked manufacturer');
    expect(matchBadge('linkedin')).toBe('LinkedIn connection');
    expect(matchBadge('something-we-add-later')).toBeTruthy();
  });
});
