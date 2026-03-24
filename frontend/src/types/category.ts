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
  children: Subcategory[];
}

export interface CategoryDetail extends Category {
  parent: { id: string; name: string; slug: string; icon: string } | null;
  suppliers: import('./supplier').Supplier[];
  sponsor: import('./sponsor').Sponsor | null;
}
