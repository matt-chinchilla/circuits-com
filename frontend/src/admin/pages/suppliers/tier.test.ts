import { describe, it, expect } from 'vitest';
import {
  deriveSupplierTier,
  supplierTierLabel,
  SUPPLIER_TIERS,
} from './tier';

// Guards the 2026-06-14 stale-schema bug: the admin suppliers panel still
// surfaced a "Featured" tier after Featured was merged into Platinum in the
// 2026-06-12 tier-board change. The derivation is a parts_count SIZE bucket,
// NOT the sponsor tier — but it must mirror the live Platinum/Gold/Silver set.

describe('deriveSupplierTier — Platinum/Gold/Silver only (no Featured)', () => {
  it('never returns the removed "Featured" tier, even for huge catalogs', () => {
    for (const n of [200, 250, 1000, 99999]) {
      const tier = deriveSupplierTier(n);
      expect(tier).not.toBe('featured');
      expect(SUPPLIER_TIERS).toContain(tier);
    }
  });

  it('folds the former Featured band (>=200) into Platinum', () => {
    expect(deriveSupplierTier(1000)).toBe('platinum');
    expect(deriveSupplierTier(200)).toBe('platinum');
    expect(deriveSupplierTier(100)).toBe('platinum');
  });

  it('keeps the Gold and Silver thresholds', () => {
    expect(deriveSupplierTier(99)).toBe('gold');
    expect(deriveSupplierTier(25)).toBe('gold');
    expect(deriveSupplierTier(24)).toBe('silver');
    expect(deriveSupplierTier(0)).toBe('silver');
  });

  it('treats null/undefined parts_count as Silver', () => {
    expect(deriveSupplierTier(undefined)).toBe('silver');
    expect(deriveSupplierTier(null)).toBe('silver');
  });
});

describe('SUPPLIER_TIERS / supplierTierLabel', () => {
  it('lists exactly platinum, gold, silver (no featured)', () => {
    expect(SUPPLIER_TIERS).toEqual(['platinum', 'gold', 'silver']);
    expect(SUPPLIER_TIERS).not.toContain('featured');
  });

  it('capitalizes for display', () => {
    expect(supplierTierLabel('platinum')).toBe('Platinum');
    expect(supplierTierLabel('gold')).toBe('Gold');
    expect(supplierTierLabel('silver')).toBe('Silver');
  });
});
