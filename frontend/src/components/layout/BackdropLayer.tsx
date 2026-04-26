import CircuitTraces from '../shared/CircuitTraces'
import styles from './BackdropLayer.module.scss'

// Persistent decorative PCB substrate. Mounts ONCE at App.tsx (above <Routes>),
// so the SVG never remounts during public-route navigation — electrons keep
// looping, the 6s draw-in animation only fires once per session, and the
// element is identical (same DOM node, same colors, same opacity, same animation
// state) on home, about, join, and contact.
//
// Layout: position absolute starting at the navbar's bottom edge ($nav-height),
// z-index: 0. Pages render at z-index: 1 (PublicLayout's `.outletWrap`) so
// page content stacks ABOVE this backdrop. To let the backdrop show through,
// each page's hero (HomePage's <HeroSection>) and band (PageHeaderBand) area
// is TRANSPARENT — the page's light --theme-surface-bg lives on a body wrapper
// that starts BELOW the band, leaving the band area as a transparent window.
export default function BackdropLayer() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <CircuitTraces variant="full" />
    </div>
  )
}
