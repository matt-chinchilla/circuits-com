import { motion } from 'framer-motion'
import styles from './PageHeaderBand.module.scss'

interface PageHeaderBandProps {
  /** Slug-friendly identifier — drives the REV-A tag (e.g. "ABOUT"). */
  page: string
  title: string
  subtitle: string
}

// Slim themed hero band rendered above About / Join / Contact page bodies.
// Sits on top of PublicLayout's persistent CircuitTraces backdrop — its bg
// is transparent, so the board shows through. Provides per-page title +
// subtitle + a JetBrains-Mono REV tag styled like a datasheet label.
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
