import { motion } from 'framer-motion'
import styles from './PageHeaderBand.module.scss'

interface PageHeaderBandProps {
  /** Slug-friendly identifier — drives the REV-A tag (e.g. "ABOUT"). */
  page: string
  title: string
  subtitle: string
}

// Slim themed header band rendered above About / Join / Contact page bodies.
// LAYOUT ONLY — the dark substrate + animated CircuitTraces SVG live in the
// persistent <BackdropLayer /> at App.tsx level. .band is transparent so the
// same SVG that's behind the home hero shines through here too: same colors,
// same animation state (electrons keep looping across navigation, draw-in
// only fires once per session). .inner has z-index: 2 so the white title +
// REV-A tag render above the backdrop.
export default function PageHeaderBand({ page, title, subtitle }: PageHeaderBandProps) {
  return (
    <section
      className={styles.band}
      aria-labelledby={`band-${page}-title`}
    >
      <div className={styles.inner}>
        <motion.span
          className={styles.tag}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' as const }}
          aria-hidden="true"
        >
          REV-A · /{page.toUpperCase()}
        </motion.span>
        <motion.h1
          id={`band-${page}-title`}
          className={styles.title}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: 'easeOut' as const }}
        >
          {title}
        </motion.h1>
        <motion.p
          className={styles.subtitle}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.16, ease: 'easeOut' as const }}
        >
          {subtitle}
        </motion.p>
      </div>
    </section>
  )
}
