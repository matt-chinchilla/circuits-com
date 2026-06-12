export interface Subcategory {
  id: string;
  name: string;
  slug: string;
  icon: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  description?: string | null;
  children: Subcategory[];
}

export interface PartsPage {
  items: import('./part').PublicPart[];
  total: number;
  page: number;
  pages: number;
  per_page: number;
}

export type PopularPartsPage = PartsPage;

export interface CategoryDetail extends Category {
  // Parent carries its own children (siblings of `this`) so subcategory pages
  // can render the SubcategoryChips strip without an extra fetch — see
  // 2026-05-16 fix for intra-category navigation on leaf pages.
  parent: {
    id: string;
    name: string;
    slug: string;
    icon: string;
    children: Subcategory[];
  } | null;
  // On a child category this is the single GOLD sponsor (newest visible); the
  // Gold-tier SponsorBlock consumes it. Null when unsold.
  sponsor: import('./sponsor').Sponsor | null;
  // The child category's SILVER sponsors (many) — feeds the SilverPartners
  // directory in the tier row. Empty on parent pages and when unsold.
  silver: import('./sponsor').PartnerSupplier[];
  parts: PartsPage;
  // Paginated rollup of parts across all subcategories of a parent category.
  // Powers the "Popular Parts" section. On leaf pages, items is empty.
  popular_parts: PopularPartsPage;
}

export interface CategoryPartners {
  // The resolved TOP-LEVEL category (a child slug resolves to its parent) and
  // its single PLATINUM Category Sponsor — fed to the always-present banner.
  // `platinum` is null when the slot is unsold (→ Open-Placement board).
  slug: string;
  name: string;
  platinum: import('./sponsor').PlatinumSponsor | null;
}
