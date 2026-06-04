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
  sponsor: import('./sponsor').Sponsor | null;
  parts: PartsPage;
  // Paginated rollup of parts across all subcategories of a parent category.
  // Powers the "Popular Parts" section. On leaf pages, items is empty.
  popular_parts: PopularPartsPage;
}
