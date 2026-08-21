import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL } from './src/shared/swCacheNames'
import { seoPrerender } from './scripts/seoPrerender'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      workbox: {
        navigateFallback: null,
        globPatterns: [],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Matches /api/categories, /api/categories/{slug}, AND
            // /api/categories/{slug}/partners — so the Preferred-Partners banner
            // endpoint lands in this StaleWhileRevalidate cache (served instantly
            // cross-session, ETag-revalidated) and is swept by bustSponsorCaches.
            urlPattern: /\/api\/categories(\/[^/?]+)?(\/partners)?\/?(\?.*)?$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: SW_CACHE_API_CATEGORIES,
              expiration: {
                maxEntries: 50,
                // 60s (was 300): bound SW staleness to match the no-cache API +
                // purge-on-sponsor-mutation model, so an un-purged client (another
                // tab or a different user) still self-heals within a minute.
                maxAgeSeconds: 60,
              },
            },
          },
          {
            urlPattern: /\/api\/(?!admin|auth|dashboard|track)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: SW_CACHE_API_GENERAL,
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60,
              },
            },
          },
        ],
      },
    }),
    // Writes one static HTML document per templated route so crawlers get a
    // real per-page <title>/description/canonical/JSON-LD instead of the one
    // byte-identical SPA shell every URL used to return. Build-time only: no
    // Node in the request path, no bytes added to any JS chunk, and nginx keeps
    // serving plain static files.
    //
    // Part pages (~3,600) ARE in scope as of 2026-08-03. They were excluded
    // while the URL scheme disagreed with itself: the sitemap and every
    // internal link used /part/{uuid} while the page canonicalised to
    // /part/{slug} — a URL that 404'd, because nothing resolved slugs.
    // Prerendering then would have baked 3,600 documents declaring themselves
    // non-canonical. Fixing that (getPartDetail branches on the UUID grammar;
    // the sitemap emits slugs) was the stated prerequisite, and it is done.
    //
    // Measured cost: build 12s -> 20s, dist 6 MB -> 48 MB. The Product JSON-LD
    // still withholds `offers` — the listing prices are synthetic demo data,
    // and markup that disagrees with the real distributor price is a manual
    // action, not a ranking.
    seoPrerender({
      manifestPath: path.resolve(__dirname, './seo-manifest.json'),
      outDir: path.resolve(__dirname, './dist'),
    }),
  ],
  resolve: {
    alias: {
      '@admin': path.resolve(__dirname, './src/admin'),
      '@public': path.resolve(__dirname, './src/public'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': 'http://api:8000',
    },
  },
  // 2026-04-19 Tier-3 #8 perf: split heavy vendor libs into their own chunks
  // so they don't bloat the main bundle. (Recharts ~400KB was previously
  // here for admin/Reports — Phase A7 2026-04-25 replaced it with hand-rolled
  // native SVG charts, dropping the dep entirely.) framer-motion + router
  // stay isolated so public-route visitors get better cache utilization
  // across deploys (app code changes don't invalidate vendor chunks).
  //
  // 2026-07-30: switched from the object form to the id-based function form so
  // Apache ECharts (admin dashboard overhaul) can be pinned to its own chunk.
  // The `echarts` chunk stays ASYNC because its only importers are lazy
  // `@admin/pages/*` routes — verify with `npm run build` that `index-*.js`
  // contains no echarts/zrender after touching this. framer-motion's runtime
  // now lives in the `motion-dom` / `motion-utils` packages, and
  // react-router-dom re-exports `react-router`; both are matched explicitly so
  // the function form reproduces what the old object form grouped.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts'
          }
          if (id.includes('node_modules/xlsx')) {
            return 'xlsx'
          }
          if (
            id.includes('node_modules/framer-motion') ||
            id.includes('node_modules/motion-dom') ||
            id.includes('node_modules/motion-utils')
          ) {
            return 'framer'
          }
          if (id.includes('node_modules/react-router')) {
            return 'router'
          }
          return undefined
        },
      },
    },
    // Bump the chunk size warning threshold — our main chunk is legitimately
    // larger than 500 KB on a first build; this silences false-positive
    // warnings without masking truly-oversized chunks.
    chunkSizeWarningLimit: 700,
  },
})
