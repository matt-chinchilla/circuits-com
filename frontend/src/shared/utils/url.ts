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

/**
 * Validate that a (possibly scheme-less) URL resolves to an http(s) endpoint,
 * returning a safe href string or `null`.
 *
 * `prependScheme` alone is NOT safe to drop into an href: it passes through any
 * value that ALREADY carries a scheme, so `javascript:alert(1)`, `data:…`, or
 * `vbscript:…` survive untouched and execute on click (stored DOM-XSS when the
 * value comes from the DB or a form). This runs the scheme-prepended candidate
 * through the URL parser and accepts ONLY `http:`/`https:`.
 *
 * Returns `null` for empty input, an unparseable value, or a non-http(s)
 * scheme, so callers render the link conditionally (`href && <a …>`).
 */
export function safeHttpUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const candidate = prependScheme(input);
  if (!candidate) return null;
  // prependScheme preserves protocol-relative URLs (//host); resolve them to
  // https so new URL() can parse them (it throws on a base-less //host).
  const absolute = candidate.startsWith('//') ? `https:${candidate}` : candidate;
  try {
    const url = new URL(absolute);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Raster image data-URLs we trust to render in <img src>. SVG is excluded —
// it can carry inline script. http(s) URLs are validated by URL parsing.
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i;

/**
 * Sanitize a value destined for an <img src>. Allows http(s) URLs and raster
 * base64 data-URLs; rejects javascript:, data:text/html, data:image/svg+xml,
 * and anything unparseable. NOTE: distinct from safeHttpUrl — that rejects
 * data: URLs, so logos (which may be data-URLs) must use THIS function.
 */
export function safeImageUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (RASTER_DATA_IMAGE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
