export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  contact_name: string | null;
  description: string | null;
  logo_url: string | null;
  is_featured: boolean;
  rank: number;
  /** Highest ACTIVE sponsorship tier, lowercase ('platinum'|'gold'|'silver'), or
   *  null when untiered. Served by the public suppliers listing (spec §1.4a);
   *  optional so pre-§1.4a payloads still typecheck. */
  tier?: string | null;
}
