export interface PublicPart {
  id: string;
  sku: string;
  slug?: string | null;
  description: string | null;
  manufacturer_name: string;
  lifecycle_status: string;
  listings_count: number;
  best_price: number | null;
  best_price_10: number | null;
  best_price_100: number | null;
  best_price_1000: number | null;
  category_icon: string | null;
  sub_slug: string | null;
}

export interface PriceBreak {
  id: string;
  min_quantity: number;
  unit_price: number;
}

export interface PartListing {
  id: string;
  supplier_name: string;
  supplier_website: string | null;
  sku: string | null;
  stock_quantity: number;
  unit_price: number;
  currency: string;
  price_breaks: PriceBreak[];
}

export interface PartDetail extends PublicPart {
  datasheet_url: string | null;
  category_name: string | null;
  // 2026-05-16: surfaced so PartPage can render Home / Parent / Sub / SKU.
  // `category_slug` is the link target for the current category. The two
  // `parent_*` fields are non-null only when the part lives on a subcategory.
  category_slug: string | null;
  parent_category_name: string | null;
  parent_category_slug: string | null;
  listings: PartListing[];
}
