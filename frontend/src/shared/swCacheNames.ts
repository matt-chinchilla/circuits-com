/**
 * Workbox runtime-cache names — the SINGLE source of truth.
 *
 * Imported by BOTH the producer (vite.config.ts, where VitePWA's runtimeCaching
 * registers these caches) AND the consumer (@admin/services/swCache, which
 * purges them after a sponsor/supplier mutation). Keeping the names in one place
 * means a rename can't silently desync the two and turn the cache-bust into a
 * no-op — which would re-open the stale-banner bug with no failure signal.
 */
export const SW_CACHE_API_CATEGORIES = 'api-categories';
export const SW_CACHE_API_GENERAL = 'api-general';

/**
 * Parameterized category requests — a specific page / sort / filter of a
 * category's parts. Held apart from `api-categories` because it is
 * NetworkFirst, not StaleWhileRevalidate: SWR would paint the PREVIOUS page's
 * rows for an instant on every pagination or sort click. Its role is offline
 * resilience, so a stale hit only happens when the network already failed, and
 * it expires in 60s regardless. Purged by @admin/services/swCache's
 * SPONSOR_CACHES like its siblings — sponsor blocks ride these responses too.
 */
export const SW_CACHE_API_CATEGORY_QUERIES = 'api-category-queries';
