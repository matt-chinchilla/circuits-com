import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
  // so they don't bloat the main bundle. Recharts (~400 KB) only renders in
  // admin/Reports — with admin routes lazy-loaded in App.tsx, recharts lives
  // inside the admin chunk naturally. The manualChunks hint here also pulls
  // framer-motion + react-router-dom into their own chunks so public-route
  // visitors get better cache utilization across deploys (app code changes
  // don't invalidate vendor chunks).
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          recharts: ['recharts'],
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
