import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import Footer from '../components/layout/Footer'
import PageHeaderBand from '../components/layout/PageHeaderBand'
import styles from './AboutPage.module.scss'

const ABOUT_STEPS = [
  {
    icon: '🔍',
    num: '01',
    title: 'Search',
    description:
      'Browse our curated directory of 15 component categories or search by manufacturer part number, keyword, or specification.',
  },
  {
    icon: '📊',
    num: '02',
    title: 'Compare',
    description:
      'See live pricing and stock across every authorized distributor in one table. Sort by price, lead time, MOQ, or package.',
  },
  {
    icon: '🤝',
    num: '03',
    title: 'Connect',
    description:
      'Click through to the distributor of your choice in a new tab. We never gate the buy-link — your relationship is with them.',
  },
] as const

const ABOUT_STATS = [
  { num: '15', label: 'Component Categories', suffix: '' },
  { num: '75', label: 'Subcategories', suffix: '+' },
  { num: '13.8', label: 'Distributor Parts', suffix: 'M' },
  { num: '23', label: 'Years Online', suffix: '' },
] as const

const ABOUT_WHY = [
  {
    icon: '🎯',
    title: 'One table, every distributor',
    body: 'Stop opening seven tabs. We pull stock and pricing from Digi-Key, Mouser, Arrow, Avnet, Newark, RS, and Future side-by-side.',
  },
  {
    icon: '📑',
    title: 'Datasheets, not marketing copy',
    body: "Every part page links to the manufacturer's authoritative datasheet. We surface the package, lifecycle status, and MOQ — not fluff.",
  },
  {
    icon: '🚪',
    title: 'No gatekeeping',
    body: "Buy-links open the distributor in a new tab. No login walls, no quote forms, no waiting on a sales rep. You're in control of the relationship.",
  },
  {
    icon: '⚙️',
    title: 'Built by engineers',
    body: 'Founded by hardware folks who got tired of bouncing between distributor portals at 1 a.m. trying to BOM a board.',
  },
] as const

// Triggers the staggered card fade-in on mount. Previously gated by an
// IntersectionObserver to defer the animation until the section scrolled
// into view — but IO callbacks fire unreliably when AnimatePresence is
// transforming the entering page's motion.div, so the `seen` flag would
// stay false and the content stayed at opacity:0 indefinitely (visible bug:
// stats stuck at "0", why-grid invisible until theme switch forced a repaint
// that re-fired the queued IO callbacks). The fade-in still animates because
// React renders one frame with seen=false (CSS opacity:0) then setTimeout
// flips to seen=true (CSS opacity:1 with transition) — browser interpolates.
// Trade-off: animation always plays on mount, not when the section enters
// viewport. Acceptable since the alternative is content silently never
// appearing on certain navigation paths.
function useInView<T extends Element>() {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSeen(true), 50)
    return () => clearTimeout(t)
  }, [])

  return [ref, seen] as const
}

interface StatTickerProps {
  value: string
  suffix: string
}

// Animates 0 → value over ~1.1s with easeOutCubic on mount.
// Detects float values (e.g. "13.8") to keep one decimal place; integer
// values use locale formatting so "13800" would render as "13,800".
// Previously gated by a `seen` prop wired to the parent's IntersectionObserver
// — but IO didn't fire reliably during AnimatePresence transitions, leaving
// the value stuck at "0" forever. Always-on-mount is reliable.
function StatTicker({ value, suffix }: StatTickerProps) {
  const [n, setN] = useState(0)
  const num = parseFloat(value)
  const isFloat = value.includes('.')

  useEffect(() => {
    const start = performance.now()
    const dur = 1100
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur)
      const ease = 1 - Math.pow(1 - k, 3)
      setN(num * ease)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [num])

  const display = isFloat ? n.toFixed(1) : Math.round(n).toLocaleString()
  return (
    <span className={styles.aboutStatNum}>
      {display}
      {suffix}
    </span>
  )
}

export default function AboutPage() {
  const [stepsRef, stepsSeen] = useInView<HTMLElement>()
  const [statsRef, statsSeen] = useInView<HTMLElement>()
  const [whyRef, whySeen] = useInView<HTMLElement>()

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
      className={styles.aboutPage}
    >
      <PageHeaderBand
        page="about"
        title="About Circuits.com"
        subtitle="The trusted directory for integrated circuits — connecting buyers, suppliers, and engineers since 2003."
      />

      {/* (2) How it works — staggered card fade-in + marching-ants connectors */}
      <section
        ref={stepsRef}
        className={`${styles.aboutSection} ${styles.aboutHow} ${stepsSeen ? styles.seen : ''}`}
      >
        <h2 className={styles.aboutSectionTitle}>How It Works</h2>
        <p className={styles.aboutSectionDek}>
          Three steps from &ldquo;I need this part&rdquo; to &ldquo;I have it on order.&rdquo;
        </p>
        <div className={styles.aboutSteps}>
          {ABOUT_STEPS.map((s, i) => (
            <article
              key={s.title}
              className={styles.aboutStep}
              style={{ ['--i' as string]: i } as React.CSSProperties}
            >
              <span className={styles.aboutStepNum} aria-hidden="true">
                {s.num}
              </span>
              <span className={styles.aboutStepIcon} aria-hidden="true">
                {s.icon}
              </span>
              <h3 className={styles.aboutStepTitle}>{s.title}</h3>
              <p className={styles.aboutStepDesc}>{s.description}</p>
              {i < ABOUT_STEPS.length - 1 && (
                <span className={styles.aboutStepConnector} aria-hidden="true">
                  <svg viewBox="0 0 60 12" preserveAspectRatio="none">
                    <line x1="0" y1="6" x2="50" y2="6" />
                    <polyline points="44,2 52,6 44,10" />
                  </svg>
                </span>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* (3) Stats strip — full-bleed gradient, PCB grid overlay, tickered nums */}
      <section
        ref={statsRef}
        className={`${styles.aboutSection} ${styles.aboutStats} ${statsSeen ? styles.seen : ''}`}
      >
        <div className={styles.aboutStatsGrid}>
          {ABOUT_STATS.map((s) => (
            <div key={s.label} className={styles.aboutStat}>
              <StatTicker value={s.num} suffix={s.suffix} />
              <span className={styles.aboutStatLabel}>{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* (4) Why — 4 value-prop cards in 2-col grid */}
      <section
        ref={whyRef}
        className={`${styles.aboutSection} ${styles.aboutWhy} ${whySeen ? styles.seen : ''}`}
      >
        <div className={styles.aboutWhyInner}>
          <h2 className={styles.aboutSectionTitle}>Why Circuits.com?</h2>
          <p className={styles.aboutWhyLead}>
            For over two decades, Circuits.com has been the go-to resource for engineers and
            purchasing managers sourcing integrated circuits, semiconductors, passive components,
            and modules. We don&rsquo;t sell parts &mdash; we make them findable.
          </p>
          <div className={styles.aboutWhyGrid}>
            {ABOUT_WHY.map((card) => (
              <article key={card.title} className={styles.aboutWhyCard}>
                <span className={styles.aboutWhyIcon} aria-hidden="true">
                  {card.icon}
                </span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* (5) CTA — primary "Join" + ghost "Browse Parts" */}
      <section className={`${styles.aboutSection} ${styles.aboutCta}`}>
        <h2 className={styles.aboutSectionTitle}>Ready to Get Listed?</h2>
        <p className={styles.aboutCtaSub}>
          Distributors and authorized resellers — join our directory and put your stock in front of
          buyers who are actively searching for components today.
        </p>
        <div className={styles.aboutCtaActions}>
          <Link to="/join" className={`${styles.glowBtn} ${styles.glowBtnGold}`}>
            Join as Distributor →
          </Link>
          <Link to="/search" className={`${styles.glowBtn} ${styles.glowBtnGhost}`}>
            Browse Parts
          </Link>
        </div>
      </section>

      <Footer />
    </motion.div>
  )
}
