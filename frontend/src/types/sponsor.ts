export interface Sponsor {
  id: string;
  supplier_name: string;
  image_url: string | null;
  description: string | null;
  tier: 'gold' | 'silver' | 'bronze';
  website: string | null;
  phone: string | null;
}
