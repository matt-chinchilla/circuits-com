// Leads — real people's contact data. ADMIN-ONLY (spec invariant 2).

export type LeadOutcome = 'converted' | 'maybe' | 'rejected';

export interface AdminLead {
  id: string;
  company_name: string;
  branch_label: string | null;
  company_slug: string;
  manufacturer_id: string | null;
  tier: string | null;
  ring: string | null;
  city: string | null;
  state: string | null;
  /** Straight-line miles from HQ to the lead's ZIP centroid, one decimal.
   *  null = ZIP absent/unknown (renders as an em-dash, excluded from
   *  distance filters server-side). `| null`, not optional: Python None
   *  arrives as JSON null and `?:` would not catch it. */
  distance_miles: number | null;
  contact_name: string | null;
  contact_title: string | null;
  /** The contact's picture (migration 059): a raster data-URL from the
   *  cropper or an http(s) URL. Render ONLY through safeImageUrl (LeadAvatar
   *  does). OPTIONAL as well as nullable: a persisted list payload can
   *  predate the key, and absent must read as "no picture". */
  photo_url?: string | null;
  needs_enrichment: boolean;
  last_outcome: LeadOutcome | null;
  last_contacted_at: string | null;
  contact_attempts: number;
  /** Username of the rep who added the lead from the console; null for rows
   *  from the roster import (seed_data/leads.csv). OPTIONAL as well as
   *  nullable: a persisted query-cache payload can predate the key, and an
   *  ABSENT value must read as "unknown", never as "from the roster". */
  created_by?: string | null;
  created_at?: string | null;
}

export interface LeadContactRow {
  id: string;
  outcome: LeadOutcome;
  sale_tier: string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface AdminLeadDetail extends AdminLead {
  street: string | null;
  postal_code: string | null;
  main_phone: string | null;
  website: string | null;
  sales_email: string | null;
  direct_phone: string | null;
  contact_email: string | null;
  linkedin_url: string | null;
  hours_tz: string | null;
  notes: string | null;
  contacts: LeadContactRow[];
}

export interface LeadListResponse {
  leads: AdminLead[];
  total: number;
  page: number;
  per_page: number;
}

export interface RecentLeadContact {
  id: string;
  lead_id: string;
  company_name: string | null;
  contact_name: string | null;
  outcome: LeadOutcome;
  sale_tier: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface RepActivity {
  username: string;
  outcome_mix: Partial<Record<LeadOutcome, number>>;
  contacts: Array<RecentLeadContact & { note: string | null }>;
}

/** Company size on the call list — the roster's S/M/L column. */
export type LeadTier = 'S' | 'M' | 'L';

/** POST /api/admin/leads/ — `LeadCreate` (extra="forbid"). Every value is
 *  trimmed client-side and an empty one is omitted, never sent as "". */
export interface LeadCreateBody {
  company_name: string;
  tier?: LeadTier | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  main_phone?: string | null;
  website?: string | null;
  sales_email?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  direct_phone?: string | null;
  contact_email?: string | null;
  linkedin_url?: string | null;
  hours_tz?: string | null;
  notes?: string | null;
  photo_url?: string | null;
}

/** The 409 `detail` of a create that would duplicate a lead. A customer's
 *  private lead answers with the code alone — its id and company are not the
 *  staff roster's to show. */
export type LeadExistsDetail =
  | { code: 'lead_exists'; lead_id: string; company_name: string; contact_name: string | null }
  | { code: 'lead_exists_private' };

/** One person (or company address) Hunter knows at the lead's domain — the
 *  candidate shape of GET /api/admin/leads/{id}/enrichment. Nothing here is
 *  stored until the rep applies it through the ordinary PATCH or POST. */
export interface EnrichmentCandidate {
  first_name: string | null;
  last_name: string | null;
  /** null for a generic address (sales@) — it names nobody, so it offers no
   *  "use" or "add" action. */
  full_name: string | null;
  email: string;
  position: string | null;
  phone: string | null;
  linkedin_url: string | null;
  /** Hunter's 0-100 confidence (Domain Search) or score (Email Finder). */
  confidence: number | null;
  /** Hunter's verification status: valid | accept_all | unknown | … */
  verification: string | null;
  /** personal | generic */
  kind: string | null;
  source: 'hunter';
  /** A roster lead at this company that already IS this person (by name or
   *  by address) — possibly the lead being viewed. */
  existing_lead_id: string | null;
}

export type EnrichmentDomainSource = 'website' | 'sales_email' | 'contact_email' | 'manufacturer';

export interface LeadEnrichment {
  provider: 'hunter';
  lead_id: string;
  domain: string;
  domain_source: EnrichmentDomainSource;
  organization: string | null;
  /** Hunter's address pattern, e.g. "{first}.{last}". */
  pattern: string | null;
  candidates: EnrichmentCandidate[];
  /** The lead's own contact, looked up by name (Email Finder) — only when
   *  the lead names someone with no address on file. */
  contact_email_suggestion: EnrichmentCandidate | null;
  /** Set when that second lookup failed but the company list arrived. */
  suggestion_error: string | null;
}
