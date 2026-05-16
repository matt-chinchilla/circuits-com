import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import ErrorBoundary from '@shared/components/ErrorBoundary'
import Footer from './Footer'
import styles from './PublicLayout.module.scss'

const RouteFallback = () => <div style={{ minHeight: 420 }} aria-busy="true" />

// Pass-through shell for public routes. Wraps the Outlet in `.outletWrap`
// (position: relative; z-index: 1) so all rendered pages stack ABOVE the
// persistent <BackdropLayer /> mounted at App.tsx level (which sits at
// z-index: 0). Pages render their hero/band areas as TRANSPARENT windows
// onto the backdrop SVG, then provide their own --theme-surface-bg via a
// body wrapper for the content area below the band.
//
// AnimatePresence was removed 2026-04-26 — Framer Motion 12's keyed-children
// + Suspense + lazy-routes combination left the second-transition entering
// motion.div stuck at the previous child's exit-state values. Each page now
// handles its own entrance animation via its own motion.div; route changes
// are hard cuts (matches the design-import reference's behavior).
//
// `<Footer />` lives here (NOT inside each page) so it's a sibling of
// <Outlet />. The .shell wrapper is a flex column with min-height: 100vh
// minus the sticky navbar; Footer has margin-top: auto so it pins to the
// viewport bottom on short pages and floats below content on long pages.
// (Fixes the "footer mid-page on /keyword/:slug" regression — 2026-05-14.)
export default function PublicLayout() {
  const location = useLocation()
  return (
    <div className={styles.shell}>
      <div className={styles.outletWrap}>
        <Suspense fallback={<RouteFallback />}>
          {/* ErrorBoundary keyed on pathname → render crashes inside any
              public page surface a recoverable fallback (with a "Back"
              button) instead of a blank screen. Key change on nav auto-
              clears the boundary's error state when the user routes away.
              Sits INSIDE .outletWrap so Navbar + Footer stay visible on
              crash and the recovery card sits in normal page flow. */}
          <ErrorBoundary key={location.pathname} scope="page">
            <Outlet />
          </ErrorBoundary>
        </Suspense>
      </div>
      <Footer />
    </div>
  )
}
