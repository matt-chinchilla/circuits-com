// The registered-account roster — admin-only (customer registration, D16).
//
// One row per `users.role = 'user'` account PLUS read-only `viewer` staff
// (alembic 051) — the owner's one view of every outside account. Admin/owner
// logins are NOT in here, and the route itself is require_staff, so this
// type never describes anything a customer can read.

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
  // A viewer gets a badge and no controls: activation, company links and
  // delete are customer-only server-side (404 for anything else).
  role: 'user' | 'viewer';
}
