// Search v2 response contract — mirrors GET /api/search/?q=&suggest= verbatim
// (spec: docs/superpowers/specs/2026-08-21-search-browse-refinements-design.md §1.3).
// Server-derived fields arrive null when unknown; render "—", never blank cells.

export interface SearchPart {
  id: string;
  sku: string;
  slug: string;
  description: string | null;
  manufacturer_name: string | null;
  package: string | null;
  mount: string | null;
  rohs: boolean | null;
  lead_time_days: number | null;
  moq: number | null;
  dist_count: number;
  best_price: number | null;
  stock: number;
  lifecycle_status: string | null;
  category_icon: string | null;
  category_slug: string | null;
  parent_category_slug: string | null;
}

export interface SearchCategoryChild {
  name: string;
  slug: string;
  matched: boolean;
}

export interface SearchCategoryHit {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  parent_slug: string | null;
  /** own + sum(children), matching the homepage rollup */
  parts_count: number;
  /** matched subcategories ordered first */
  children: SearchCategoryChild[];
}

export interface SearchSupplierHit {
  id: string;
  name: string;
  website: string | null;
  logo_url: string | null;
  description: string | null;
  /** highest ACTIVE sponsorship tier, lowercase, or null when untiered */
  tier: string | null;
}

export interface SearchManufacturerHit {
  name: string;
  parts_count: number;
}

export interface SearchSuggestion {
  term: string;
  kind: 'distributor' | 'manufacturer' | 'category';
  /** Phosphor icon name for kind === 'category', null otherwise
   *  (clients derive lettermark pads from `term`). */
  icon: string | null;
}

export interface SearchResultsV2 {
  parts: SearchPart[];
  categories: SearchCategoryHit[];
  suppliers: SearchSupplierHit[];
  manufacturers: SearchManufacturerHit[];
  total: number;
  took_ms: number;
  /** populated only on total === 0 AND suggest=1 requests */
  suggestions: SearchSuggestion[] | null;
  closest_parts: SearchPart[] | null;
}

export interface PublicManufacturers {
  manufacturers: SearchManufacturerHit[];
  /** full derived-list length — the list itself is capped by ?limit */
  total: number;
}
