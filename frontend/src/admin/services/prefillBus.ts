// Cross-page form pre-fill bus used by the Supplier-detail Quick Actions
// panel. A click stashes a context packet here and navigates; the destination
// form's first render consumes the packet and seeds its initial state.
//
// Persists through SPA navigation (module memory survives), wiped by a full
// page reload — which is exactly what one-shot pre-fill needs. Consume
// clears so back-navigation doesn't re-apply stale data.

export type PrefillKind = 'part' | 'sponsor' | 'import';

export interface PartPrefill {
  supplier_id: string;
  supplier_name: string;
  manufacturer_name?: string;
  category_id?: string;
  // Captured so the Part form's optional Initial Listing fieldset knows
  // which supplier to wire and can render the "New part for X" banner.
}

export interface SponsorPrefill {
  supplier_id: string;
  supplier_name: string;
  tier?: 'Platinum' | 'Gold' | 'Silver';
  category_id?: string;
}

export interface ImportPrefill {
  supplier_id: string;
  supplier_name: string;
}

type PrefillMap = {
  part: PartPrefill;
  sponsor: SponsorPrefill;
  import: ImportPrefill;
};

let pending: { kind: PrefillKind; data: unknown } | null = null;

export function setPrefill<K extends PrefillKind>(kind: K, data: PrefillMap[K]): void {
  pending = { kind, data };
}

export function consumePrefill<K extends PrefillKind>(kind: K): PrefillMap[K] | null {
  if (pending && pending.kind === kind) {
    const data = pending.data as PrefillMap[K];
    pending = null;
    return data;
  }
  return null;
}
