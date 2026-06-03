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
