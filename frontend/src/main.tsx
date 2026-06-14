import React from 'react'
import ReactDOM from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@admin/contexts/AuthContext'
import { installPreloadErrorRecovery } from '@shared/preloadErrorRecovery'
import App from './App'
import '@shared/styles/global.scss'

// Self-heal stale lazy-chunk 404s after a deploy: turn Vite's `vite:preloadError`
// into a single recovery reload instead of an ErrorBoundary dead-end that needs
// a manual cache reset. Must run before render so the listener is live when the
// first lazy route imports. See @shared/preloadErrorRecovery.
installPreloadErrorRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  </React.StrictMode>,
)
