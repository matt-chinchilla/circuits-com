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
  contact_name: string | null;
  contact_title: string | null;
  needs_enrichment: boolean;
  last_outcome: LeadOutcome | null;
  last_contacted_at: string | null;
  contact_attempts: number;
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
