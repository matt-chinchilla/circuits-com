import { describe, it, expect } from 'vitest';
import { mountPath } from '@admin/services/consolePath';
import { manufacturingPair, supplyPair } from './accountPairs';

// The rule these pin is the surface map's, not a rendering detail: a half is
// offered only for a link the account actually holds, both links is a normal
// account rather than a special case, and a single capability yields ONE half
// — which CatalogSwitch renders as no switch at all.
//
// The real caller is a customer, so the mount translation is what the halves
// carry: `staff` is here only to show the same rule reads identically at both.
const customer = (p: string) => mountPath(p, '/account');
const staff = (p: string) => mountPath(p, '/admin');

describe('supplyPair', () => {
  it('offers both halves to an account holding both links', () => {
    expect(supplyPair(customer, true, true)).toEqual([
      { to: '/account/suppliers', label: 'Suppliers' },
      { to: '/account/my-supply', label: 'My Supply' },
    ]);
  });

  it('gives a distributor only its own supply page', () => {
    expect(supplyPair(customer, true, false).map((h) => h.to)).toEqual(['/account/my-supply']);
  });

  it('gives a manufacturer only the distributors selling its products', () => {
    expect(supplyPair(customer, false, true).map((h) => h.to)).toEqual(['/account/suppliers']);
  });

  it('gives a free account nothing', () => {
    expect(supplyPair(customer, false, false)).toEqual([]);
  });

  it('addresses whichever mount is rendering', () => {
    expect(supplyPair(staff, true, true).map((h) => h.to)).toEqual([
      '/admin/suppliers',
      '/admin/my-supply',
    ]);
  });
});

describe('manufacturingPair', () => {
  it('offers both halves to an account holding both links', () => {
    expect(manufacturingPair(customer, true, true)).toEqual([
      { to: '/account/manufacturers', label: 'Manufacturers' },
      { to: '/account/my-manufacturing', label: 'My Manufacturing' },
    ]);
  });

  it('gives a distributor the makers whose products it sells', () => {
    expect(manufacturingPair(customer, true, false).map((h) => h.to)).toEqual([
      '/account/manufacturers',
    ]);
  });

  it('gives a manufacturer only its own maker page', () => {
    expect(manufacturingPair(customer, false, true).map((h) => h.to)).toEqual([
      '/account/my-manufacturing',
    ]);
  });

  it('gives a free account nothing', () => {
    expect(manufacturingPair(customer, false, false)).toEqual([]);
  });
});
