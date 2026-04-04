export interface PublicPart {
  id: string;
  sku: string;
  description: string | null;
  manufacturer_name: string;
  lifecycle_status: string;
  listings_count: number;
  best_price: number | null;
  category_icon: string | null;
}

export interface PartListing {
  id: string;
  supplier_name: string;
  sku: string | null;
  stock_quantity: number;
  unit_price: number;
  currency: string;
}

export interface PartDetail extends PublicPart {
  datasheet_url: string | null;
  category_name: string | null;
  listings: PartListing[];
}
