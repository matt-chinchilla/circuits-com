// Manufacturers — admin-only entity (Leads CRM, 2026-08-20). Never imported
// from @public/@shared: the eslint zone is the mechanical privacy guarantee.

export interface AdminManufacturer {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  source: 'csv' | 'catalog' | 'manual';
  catalog_part_count: number;
  external_part_count: number | null;
  linked_supplier_id: string | null;
  linked_supplier_name: string | null;
}

export interface ManufacturerAliasRow {
  alias: string;
  source: string;
  confidence: string;
}

export interface MergeCandidate {
  id: string;
  right_alias: string;
  rule: string;
  evidence: string | null;
  status: string;
}

export interface LinkedSponsorship {
  id: string;
  tier: string;
  status: string | null;
  category_id: string | null;
  keyword: string | null;
}

export interface AdminManufacturerDetail extends AdminManufacturer {
  description: string | null;
  logo_url: string | null;
  canonical_key: string;
  external_part_count_as_of: string | null;
  aliases: ManufacturerAliasRow[];
  merge_candidates: MergeCandidate[];
  linked_supplier_sponsorships: LinkedSponsorship[];
}

export interface ManufacturerListResponse {
  manufacturers: AdminManufacturer[];
  total: number;
  page: number;
  per_page: number;
}
