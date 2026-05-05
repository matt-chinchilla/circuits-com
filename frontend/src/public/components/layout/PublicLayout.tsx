import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
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
export default function PublicLayout() {
  return (
    <div className={styles.outletWrap}>
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    </div>
  )
}
