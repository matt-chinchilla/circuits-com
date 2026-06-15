import type { AdminSponsor, SponsorTier } from '@admin/types/admin';
import {
  isActiveSponsor,
  normalizeSponsorTier,
  SPONSOR_TIER_RANK,
} from '@admin/services/sponsorTier';

// A supplier's badge on the admin Suppliers surface = their ACTUAL active
// sponsorship tier (the highest, if they hold several), or 'None' when they have
// no active sponsorship. Distinct from the parts_count SIZE tier in ./tier
// (which only pre-fills a NEW sponsorship). AdminSupplier carries no sponsorship
// field, so we cross-reference the sponsor rows by supplier_id.

export type SupplierSponsorship = SponsorTier | 'None';
export type SponsorshipFilter = 'All' | SupplierSponsorship;

// List-page filter order: All, the no-sponsorship bucket, then descending tiers.
export const SPONSORSHIP_FILTERS: SponsorshipFilter[] = [
  'All',
  'None',
  'Platinum',
  'Gold',
  'Silver',
];

// supplier_id -> highest active sponsorship tier (canonical TitleCase). Suppliers
// with no active sponsorship are absent (→ 'None' via supplierSponsorship). Tier
// casing is normalized — legacy seed stores lowercase 'platinum'.
export function buildSponsorshipBySupplier(
  sponsors: AdminSponsor[],
): Map<string, SponsorTier> {
  const best = new Map<string, SponsorTier>();
  for (const s of sponsors) {
    if (!isActiveSponsor(s.status)) continue;
    const tier = normalizeSponsorTier(s.tier);
    if (!tier) continue; // outside the live set (e.g. the dropped 'Featured')
    const cur = best.get(s.supplier_id);
    if (!cur || SPONSOR_TIER_RANK[tier] > SPONSOR_TIER_RANK[cur]) {
      best.set(s.supplier_id, tier);
    }
  }
  return best;
}

export function supplierSponsorship(
  supplierId: string,
  bySupplier: Map<string, SponsorTier>,
): SupplierSponsorship {
  return bySupplier.get(supplierId) ?? 'None';
}
