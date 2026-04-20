import { Suspense } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Outlet, useLocation } from 'react-router-dom'
import CircuitTraces from '../shared/CircuitTraces'
import styles from './PublicLayout.module.scss'

// Reserved hero-region height while a lazy-route chunk streams in.
const RouteFallback = () => <div style={{ minHeight: 420 }} aria-busy="true" />

// Persistent shell for every public route. The CircuitTraces SVG mounts ONCE
// for the session — variant flips between 'full' (home) and 'static' (inner
// pages) via a prop on navigation, not a remount, so the IntersectionObserver
// + data-paused wiring in CircuitTraces stays intact across route changes.
//
// AnimatePresence + Suspense live HERE (not App.tsx) so PublicLayout itself
// never unmounts during public navigation. Only the keyed motion.div around
// the Outlet swaps, carrying the page crossfade.
export default function PublicLayout() {
  const location = useLocation()
  const variant = location.pathname === '/' ? 'full' : 'static'

  return (
    <>
      <div className={styles.backdrop} aria-hidden="true">
        <CircuitTraces variant={variant} />
      </div>
      <AnimatePresence mode="popLayout">
        <motion.div
          key={location.pathname}
          className={styles.outletWrap}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15, ease: 'easeInOut' as const }}
        >
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </>
  )
}
