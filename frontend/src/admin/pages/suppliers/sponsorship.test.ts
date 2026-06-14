import { describe, it, expect } from 'vitest';
import type { AdminSponsor } from '@admin/types/admin';
import {
  buildSponsorshipBySupplier,
  supplierSponsorship,
  SPONSORSHIP_FILTERS,
} from './sponsorship';

// Minimal sponsor-row factory — the derivation only reads supplier_id/tier/status.
function row(
  supplier_id: string,
  tier: string,
  status: string | null,
): AdminSponsor {
  return { supplier_id, tier, status } as unknown as AdminSponsor;
}

describe('supplierSponsorship — a supplier badge = real active sponsorship', () => {
  it('returns None when the supplier has no sponsor rows at all', () => {
    const map = buildSponsorshipBySupplier([]);
    expect(supplierSponsorship('ghost', map)).toBe('None');
  });

  it('returns the single active tier a supplier holds', () => {
    const map = buildSponsorshipBySupplier([row('a', 'Gold', 'Active')]);
    expect(supplierSponsorship('a', map)).toBe('Gold');
  });

  it('returns the HIGHEST active tier when a supplier holds several', () => {
    const map = buildSponsorshipBySupplier([
      row('a', 'Silver', 'Active'),
      row('a', 'Platinum', 'Active'),
      row('a', 'Gold', 'Active'),
    ]);
    expect(supplierSponsorship('a', map)).toBe('Platinum');
  });

  it('ignores Paused and Expired rows (those are not active)', () => {
    const map = buildSponsorshipBySupplier([
      row('b', 'Platinum', 'Paused'),
      row('b', 'Gold', 'Expired'),
    ]);
    expect(supplierSponsorship('b', map)).toBe('None');
  });

  it('counts a null status as Active (legacy seed omits status)', () => {
    const map = buildSponsorshipBySupplier([row('c', 'Gold', null)]);
    expect(supplierSponsorship('c', map)).toBe('Gold');
  });

  it('picks the highest ACTIVE tier, ignoring a higher expired one', () => {
    const map = buildSponsorshipBySupplier([
      row('d', 'Gold', 'Active'),
      row('d', 'Platinum', 'Expired'),
    ]);
    expect(supplierSponsorship('d', map)).toBe('Gold');
  });

  it('normalizes a legacy lowercase tier ("platinum" from the seed) to Platinum', () => {
    const map = buildSponsorshipBySupplier([row('legacy', 'platinum', null)]);
    expect(supplierSponsorship('legacy', map)).toBe('Platinum');
  });

  it('compares tier casing-insensitively across mixed-case rows', () => {
    const map = buildSponsorshipBySupplier([
      row('m', 'silver', 'Active'),
      row('m', 'GOLD', null),
    ]);
    expect(supplierSponsorship('m', map)).toBe('Gold');
  });
});

describe('SPONSORSHIP_FILTERS', () => {
  it('offers None alongside All + the three live tiers', () => {
    expect(SPONSORSHIP_FILTERS).toEqual([
      'All',
      'None',
      'Platinum',
      'Gold',
      'Silver',
    ]);
  });
});
