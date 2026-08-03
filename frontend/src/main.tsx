import React from 'react'
import ReactDOM from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@admin/contexts/AuthContext'
import { installPreloadErrorRecovery } from '@shared/preloadErrorRecovery'
import { dropPrerenderedSeoTags } from '@shared/seoPrerenderHandoff'
import App from './App'
import '@shared/styles/global.scss'

// Self-heal stale lazy-chunk 404s after a deploy: turn Vite's `vite:preloadError`
// into a single recovery reload instead of an ErrorBoundary dead-end that needs
// a manual cache reset. Must run before render so the listener is live when the
// first lazy route imports. See @shared/preloadErrorRecovery.
installPreloadErrorRecovery()

// Must run BEFORE the first render: <PageHead> re-renders the prerendered head
// tags through helmet, which on React 19 appends instead of replacing them.
// See @shared/seoPrerenderHandoff.
dropPrerenderedSeoTags()

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
