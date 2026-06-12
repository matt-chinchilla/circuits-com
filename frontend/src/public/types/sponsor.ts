export interface Sponsor {
  id: string;
  supplier_name: string;
  image_url: string | null;
  description: string | null;
  // Free-form: seed uses lowercase ('gold'/'silver'); admin form emits
  // TitleCase ('Featured'/'Platinum'/'Gold'/'Silver'). SponsorBlock lowercases
  // before matching [data-tier=...].
  tier: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
}

/**
 * The single Platinum Category Sponsor on a top-level category. Mirrors the
 * API's `/categories/{slug}/partners` → `platinum` object (a Sponsor row joined
 * to its Supplier). All optional fields are nullable on the wire (Python None →
 * JSON null), so they MUST be typed `?: T | null` and read with `!= null` — a
 * bare `field?: T` would let a `null` slip past (the project's null gotcha).
 */
export interface PlatinumSponsor {
  id: string;
  supplier_name: string; // → company
  image_url?: string | null; // → logo (fallback to logo_url)
  description?: string | null; // → blurb
  tier: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  contact_name?: string | null; // → contact
  logo_url?: string | null;
  contact_role?: string | null; // → role
  coverage_hours?: string | null; // → hours
  brand_primary?: string | null;
  brand_secondary?: string | null;
}

/**
 * A Silver-tier directory supplier. Mirrors one element of the API's
 * `/categories/{slug}` → `silver: SupplierResponse[]` (a child category's Silver
 * sponsors, joined to their Supplier). Same null-on-the-wire caveat as
 * PlatinumSponsor — every optional field is `?: T | null`, read with `!= null`.
 */
export interface PartnerSupplier {
  id: string;
  name: string;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  description?: string | null;
  logo_url?: string | null;
}
