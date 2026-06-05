import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL } from './src/shared/swCacheNames'

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
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          framer: ['framer-motion'],
          router: ['react-router-dom'],
        },
      },
    },
    // Bump the chunk size warning threshold — our main chunk is legitimately
    // larger than 500 KB on a first build; this silences false-positive
    // warnings without masking truly-oversized chunks.
    chunkSizeWarningLimit: 700,
  },
})
