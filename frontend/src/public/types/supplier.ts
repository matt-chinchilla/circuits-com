export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  description: string | null;
  logo_url: string | null;
  is_featured: boolean;
  rank: number;
}
