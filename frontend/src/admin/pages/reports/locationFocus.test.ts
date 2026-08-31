import { describe, it, expect } from 'vitest';
import { focusFor, matchTown } from './locationFocus';
import type { GeoCityRow } from '@admin/types/admin';

const town = (city: string, region: string | null, country: string | null, extra = {}): GeoCityRow =>
  ({ city, region, country, lat: 0, lng: 0, views: 1, ...extra }) as GeoCityRow;

describe('focusFor', () => {
  it('carries the location through with the nonce', () => {
    expect(focusFor({ city: 'Austin', region: 'Texas', country: 'US' }, 3)).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'US',
      nonce: 3,
    });
  });

  it('refuses a location with no country — there is nothing to point at', () => {
    expect(focusFor({ city: 'Austin', region: 'Texas', country: null }, 1)).toBeNull();
    expect(focusFor({ city: null, region: null, country: '' }, 1)).toBeNull();
  });

  it('allows a country-only location, which focuses the country', () => {
    expect(focusFor({ city: null, region: null, country: 'DE' }, 7)).toEqual({
      city: null,
      region: null,
      country: 'DE',
      nonce: 7,
    });
  });
});

describe('matchTown', () => {
  const towns = [
    town('New York', 'New York', 'US'),
    town('Springfield', 'Illinois', 'US'),
    town('Springfield', 'Massachusetts', 'US'),
    town('London', 'England', 'GB'),
    town('London', 'Ontario', 'CA'),
  ];

  it('finds the town for a city+region+country request', () => {
    const hit = matchTown(towns, { city: 'New York', region: 'New York', country: 'US', nonce: 1 });
    expect(hit?.city).toBe('New York');
  });

  it('separates two cities that share a name in different countries', () => {
    expect(matchTown(towns, { city: 'London', region: 'England', country: 'GB', nonce: 1 })?.region)
      .toBe('England');
    expect(matchTown(towns, { city: 'London', region: 'Ontario', country: 'CA', nonce: 1 })?.region)
      .toBe('Ontario');
  });

  it('uses the region to break a tie inside one country', () => {
    expect(
      matchTown(towns, { city: 'Springfield', region: 'Massachusetts', country: 'US', nonce: 1 })
        ?.region,
    ).toBe('Massachusetts');
  });

  it('still matches when only one side carries a region', () => {
    // The organization roll-up and the town list are two aggregations of the
    // same page views; a row can carry a region on one side and null on the
    // other. Requiring both to agree would drop a match the reader can see in
    // both lists.
    expect(matchTown(towns, { city: 'New York', region: null, country: 'US', nonce: 1 })?.city)
      .toBe('New York');
    expect(
      matchTown([town('Austin', null, 'US')], {
        city: 'Austin',
        region: 'Texas',
        country: 'US',
        nonce: 1,
      })?.city,
    ).toBe('Austin');
  });

  it('ignores case and stray whitespace on both sides', () => {
    expect(matchTown(towns, { city: '  new york ', region: null, country: 'us', nonce: 1 })?.city)
      .toBe('New York');
  });

  it('tolerates a town row whose country predates the field', () => {
    expect(matchTown([town('Austin', 'Texas', null)], {
      city: 'Austin', region: 'Texas', country: 'US', nonce: 1,
    })?.city).toBe('Austin');
  });

  it('returns null rather than guessing', () => {
    expect(matchTown(towns, { city: 'Nowhere', region: null, country: 'US', nonce: 1 })).toBeNull();
    // A country-only request has no town to fly to — the caller focuses the
    // country on the choropleth instead.
    expect(matchTown(towns, { city: null, region: null, country: 'US', nonce: 1 })).toBeNull();
    expect(matchTown([], { city: 'New York', region: null, country: 'US', nonce: 1 })).toBeNull();
  });

  it('does not match the same city in the wrong country', () => {
    expect(matchTown(towns, { city: 'London', region: null, country: 'FR', nonce: 1 })).toBeNull();
  });
});
