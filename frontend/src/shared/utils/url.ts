// URL helpers shared across admin + public scopes.
//
// History: previously inlined as `prependScheme()` in
// admin/pages/suppliers/form/index.tsx AND
// public/pages/category/components/PreferredPartnersBanner.tsx. The
// ≥2-consumer rule was satisfied; promoting it here so the next consumer
// (parts form, sponsor form, anywhere a user types a bare hostname) can
// import instead of copy-paste.

/**
 * RFC-3986-aware https:// prepender.
 *
 * Returns the input unchanged if it already carries a scheme (`mailto:`,
 * `ftp://`, `tel:`) or is a protocol-relative URL (`//acme.com`). Otherwise
 * prepends `https://`.
 *
 * Naive `!startsWith('http')` would corrupt `mailto:foo@bar` → `https://mailto:foo@bar`
 * and `//acme.com` → `https:////acme.com`. Guard regex matches the RFC scheme
 * grammar (lowercase ASCII letter + alnum/+/./- tail).
 */
export function prependScheme(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return trimmed;
  return `https://${trimmed}`;
}
