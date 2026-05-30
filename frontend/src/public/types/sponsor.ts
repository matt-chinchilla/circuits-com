export interface Sponsor {
  id: string;
  supplier_name: string;
  image_url: string | null;
  description: string | null;
  // Free-form: seed uses lowercase ('gold'/'silver'); admin form emits
  // TitleCase ('Featured'/'Platinum'/'Gold'/'Silver'). SponsorBlock lowercases
  // before matching [data-tier=...].
  tier: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
}
