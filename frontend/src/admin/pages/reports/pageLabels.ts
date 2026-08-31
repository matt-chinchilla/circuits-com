/**
 * How a tracked path is shown to a human.
 *
 * `page_views.path` stores what the tracker recorded — a root-relative path
 * beginning with "/". That is the right thing to STORE and the wrong thing to
 * read: a "Top page" of "/" tells the owner nothing, and a column of paths
 * that all start with the same slash spends its first character saying
 * something every row already agrees on (owner, 2026-08-31).
 */

/** The site the admin is served from — the public site shares its origin, so
 *  this is correct in prod and on localhost without a hardcoded domain. */
function siteOrigin(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/**
 * The KPI's answer to "top page": a real, clickable-looking URL.
 *
 * The home page is the case that forced this — as a bare path it renders as a
 * single "/" character, which reads as missing data rather than as the busiest
 * page on the site.
 */
export function pageUrl(path: string | undefined, origin = siteOrigin()): string {
  if (!path) return '—';
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The list's answer: the path without its leading slash, because every row
 * would carry the same one.
 *
 * The root has nothing left after that strip, so it is named instead — an
 * empty cell would be indistinguishable from a bug.
 */
export function pageLabel(path: string | undefined): string {
  if (!path) return '—';
  if (path === '/') return 'home';
  return path.replace(/^\/+/, '') || 'home';
}
