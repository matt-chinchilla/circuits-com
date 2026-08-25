// The registered-account roster — admin-only (customer registration, D16).
//
// One row per `users.role = 'user'` account. Staff logins are NOT in here:
// `GET /api/admin/users/` filters to customers, and the route itself is
// require_staff, so this type never describes anything a customer can read.

export interface AdminUser {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
  // `?: T | null` because Python None becomes JSON null, which `?: T` alone
  // does NOT catch — read these with `!= null`.
  //
  // signup_country is an ISO-3166 alpha-2 code stamped at signup from the
  // DB-IP database (never re-derivable later, so a null stays null).
  signup_country?: string | null;
  // website + company are read off the LINKED SUPPLIER, not off the account.
  // Both are null until staff link one, which is most rows at launch.
  website?: string | null;
  company?: string | null;
  // Derived from the linked supplier's highest active sponsorship — there is
  // no tier column to drift (services/account_tier.py).
  tier: 'free' | 'silver' | 'gold' | 'platinum';
  email_verified_at?: string | null;
  activated_at?: string | null;
  supplier_id?: string | null;
  manufacturer_id?: string | null;
}
