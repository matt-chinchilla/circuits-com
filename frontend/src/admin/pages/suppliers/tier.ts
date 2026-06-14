// Single source of truth for the admin supplier "tier" — a rough SIZE bucket
// derived from parts_count (catalog depth), NOT the sponsor tier (those live in
// `sponsors`). All three supplier surfaces (list, detail, quick-actions) import
// this so the buckets can't drift apart — which they did (2026-06-14): the
// 2026-06-12 tier-board change merged "Featured" into Platinum, but two of the
// three call sites kept deriving a stale Featured bucket. Platinum/Gold/Silver
// only — there is no Featured tier.

export type SupplierTier = 'platinum' | 'gold' | 'silver';

// List-page filter order, highest catalog depth first.
export const SUPPLIER_TIERS: SupplierTier[] = ['platinum', 'gold', 'silver'];

export function deriveSupplierTier(
  parts_count: number | null | undefined,
): SupplierTier {
  const n = parts_count ?? 0;
  if (n >= 100) return 'platinum'; // absorbs the former Featured band (>=200)
  if (n >= 25) return 'gold';
  return 'silver';
}

export function supplierTierLabel(tier: SupplierTier): Capitalize<SupplierTier> {
  return (tier.charAt(0).toUpperCase() +
    tier.slice(1)) as Capitalize<SupplierTier>;
}
