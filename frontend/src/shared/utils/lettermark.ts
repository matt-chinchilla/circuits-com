// Lettermark (initials) helper shared across admin + public scopes.
//
// History: previously inlined in 3 places with subtly different semantics
// (suppliers/list returned 1 char, parts/detail + PreferredPartnersBanner
// returned 2 chars with null-safe handling). Unified on the most capable
// variant: null-safe input + up to 2 chars.

/**
 * Initials for a supplier/manufacturer/company name.
 *
 * - Null/undefined/empty → "?"
 * - Single word ("Microsemi") → first 2 chars uppercased ("MI")
 * - Multi-word ("Texas Instruments") → first letter of first 2 words ("TI")
 *
 * Always returns 1–2 uppercase ASCII letters; safe for fixed-width badges.
 */
export function lettermark(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
