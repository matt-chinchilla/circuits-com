import { SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL } from '@shared/swCacheNames';
import { clearPartnersMemo } from '@shared/services/partnersMemo';

// Every Workbox runtime cache that can hold sponsor-derived PUBLIC data:
//  - api-categories (StaleWhileRevalidate): the Preferred Partners banner +
//    featured_supplier_name, on BOTH the category list and detail responses.
//  - api-general (NetworkFirst): the keyword sponsor profile pages
//    (/api/sponsors/keyword/...). NetworkFirst already serves fresh online, so
//    purging here is the offline/slow-client safety net.
const SPONSOR_CACHES = [SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL];

/**
 * Purge the SW caches holding sponsor-derived public data so the public site
 * reflects an admin sponsor/supplier mutation on the NEXT navigation instead of
 * serving a stale cached copy. Called from the adminApi mutation choke point
 * (sponsor create/update/delete, supplier update/delete — supplier delete
 * cascades to sponsor deletion server-side), so no individual call site can
 * forget it.
 *
 * Best-effort: the triggering mutation has already committed, so any eviction
 * failure is swallowed (a stale entry self-heals within the SW maxAge). No-op
 * where the Cache Storage API is unavailable (SSR / plain-http dev / no SW).
 */
export async function bustSponsorCaches(): Promise<void> {
  // Clear the in-memory partners memo first (sync) so a same-tab admin→public
  // navigation can't short-circuit this bust and render stale partners.
  clearPartnersMemo();
  if (typeof caches === 'undefined') return;
  try {
    await Promise.all(SPONSOR_CACHES.map((name) => caches.delete(name)));
  } catch {
    // Non-fatal; SW entries self-heal within their maxAge (vite.config.ts).
  }
}
