import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import PageHead from "@public/components/PageHead";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import { Link } from 'react-router-dom'
import PageHeaderBand from '@public/components/layout/PageHeaderBand'
import Icon from '@shared/components/Icon'
import { api } from '@public/services/api'
import type { SiteStats } from '@public/types/stats'
import { BADGE_SCHEMES } from '@shared/types/badge'
import { Fire } from '@public/pages/join/fireEdge/Fire'
import { FOUNDER_DEAL_USD } from '@public/pages/join/founderDeal'
import { NO_VALUE, STAT_TILES, compactCount } from './siteStats'
import CausticField from './CausticField'
import { useFounderBlock } from './useFounderBlock'
import styles from './AboutPage.module.scss'

const ABOUT_STEPS = [
  {
    icon: 'magnifying-glass',
    num: '01',
    title: 'Search',
    description:
      'Browse our curated directory of 28 component categories or search by manufacturer part number, keyword, or specification.',
  },
  {
    icon: 'chart-bar',
    num: '02',
    title: 'Compare',
    description:
      'See live pricing and stock across every authorized distributor in one table. Sort by price, lead time, MOQ, or package.',
  },
  {
    icon: 'handshake',
    num: '03',
    title: 'Connect',
    description:
      'Click through to the distributor of your choice in a new tab. We never gate the buy link, so your relationship stays with them.',
  },
] as const

// The commitments are NOT a sequence — no numbers, no order implied beyond
// reading order. Bodies are JSX so the curly apostrophes stay entities and the
// last row can carry its link.
const WHY_RAIL: ReadonlyArray<{ claim: string; body: ReactNode }> = [
  {
    claim: 'A way up for the businesses still growing',
    body: (
      <>
        Our pricing is set for a distributor&rsquo;s first marketing dollar, not its hundredth. The
        BOM tool, the in-browser Design Viewer and the live comparison table exist so a small
        supplier can be as findable as the largest.
      </>
    ),
  },
  {
    claim: 'We only grow when you do',
    body: (
      <>
        There is no other path. Circuit Center is a small, personable company, and every bit of our
        growth is downstream of our customers&rsquo; growth. That is why we hold ourselves to a
        standard for quality and customer experience that almost no industry bothers to reach.
      </>
    ),
  },
  {
    claim: 'Useful feedback gets paid',
    body: (
      <>
        Tell us what would make the directory work harder for you. When it is useful, we pay for
        it, in money and in benefits tailored to your company, like a company page designed for you
        on Circuit Center or an engineer&rsquo;s time on your data pipeline, at no charge.
      </>
    ),
  },
  {
    claim: 'Something new ships every day',
    body: (
      <>
        The site changes daily. If you want something it does not do yet, tell us on the{' '}
        <Link to="/contact" className={styles.whyLink}>
          contact page
        </Link>{' '}
        and a person will answer.
      </>
    ),
  },
]

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

/**
 * The strip's four figures, or null until they land.
 *
 * They were four hardcoded strings until 2026-08-31 — 13.8M parts against a
 * real catalog of 314k, and a "23 Years Online" that was never true at all.
 * There is deliberately NO fallback constant: a stale literal is the defect
 * this replaced, so a failed fetch shows `NO_VALUE` and says nothing rather
 * than something plausible and wrong.
 */
function useSiteStats(): SiteStats | null {
  const [stats, setStats] = useState<SiteStats | null>(null)

  useEffect(() => {
    // Cancel-flag: the request outlives a fast back-navigation off /about.
    let cancelled = false
    api
      .getSiteStats()
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      // Swallowed on purpose — the strip degrades to dashes and the rest of
      // the page is unaffected.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return stats
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

/**
 * The Founder's Deal — the page's one bold element, in the Join page's Founder
 * material (black dotted slab, brand-red palette) with both Founder badges at
 * hero scale (96px, the right column). Its lip catches fire the first time the block is properly in
 * view and keeps burning; that ignition is the only orchestrated moment here.
 */
function FounderDeal() {
  const blockRef = useRef<HTMLDivElement | null>(null)
  const { ignited, onScreen } = useFounderBlock(blockRef)
  const [schemeIx, setSchemeIx] = useState(0)

  // Both badges step through the enamel colours together every 3s — the Join
  // page's rhythm — but only while someone can see them.
  useEffect(() => {
    if (!onScreen) return undefined
    const id = window.setInterval(() => setSchemeIx((i) => (i + 1) % BADGE_SCHEMES.length), 3000)
    return () => window.clearInterval(id)
  }, [onScreen])

  const scheme = BADGE_SCHEMES[schemeIx]

  return (
    <div ref={blockRef} className={styles.founderBlock}>
      <span className={styles.founderTag}>Fd &middot; Founder&rsquo;s Deal</span>
      <span
        className={styles.founderBadges}
        role="img"
        aria-label="Founder&rsquo;s Badge, pulsing and burning variants"
      >
        <glow-badge size={96} scheme={scheme} glow={2} speed={3} />
        <fire-badge badge="true" size={96} scheme={scheme} intensity={1.6} opacity={1} sparks="true" />
      </span>
      <h3 className={styles.founderTitle}>Founders are appreciated like they can&rsquo;t believe.</h3>
      <div className={styles.founderCopy}>
        <p>
          Interest in Circuit Center has outrun every expectation we set for it, so the
          Founder&rsquo;s Deal is open for a limited time only. Join while it is and you keep the
          Founder&rsquo;s Badge beside your name, first access to everything that ships after, and
          the price you joined at, for as long as you stay.
        </p>
        <p>
          Silver is {FOUNDER_DEAL_USD.silver} a month, Gold is {FOUNDER_DEAL_USD.gold} and Platinum
          is {FOUNDER_DEAL_USD.platinum}. That number never goes up.
        </p>
      </div>
      <div className={styles.founderActions}>
        <Link to="/join?founder=1" className={`${styles.glowBtn} ${styles.founderBtn}`}>
          Claim the Founder&rsquo;s Deal
        </Link>
        <Link to="/contact" className={`${styles.glowBtn} ${styles.founderBtnGhost}`}>
          Talk to us
        </Link>
      </div>
      {/* Burning lip — a 2px anchor on the bottom rim; the <fire-edge lip>
          inside paints the particle fire, exactly as the Join band's .fdFire. */}
      <span className={styles.founderFire} aria-hidden="true">
        <Fire on={ignited} mode="lip" delay="0" dur="2" scale="16" sustain="0.35" />
      </span>
    </div>
  )
}

export default function AboutPage() {
  const [stepsRef, stepsSeen] = useInView<HTMLElement>()
  const [statsRef, statsSeen] = useInView<HTMLElement>()
  const stats = useSiteStats()

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
      className={styles.aboutPage}
    >
      <PageHead seo={STATIC_PAGE_SEO.about} />
      <PageHeaderBand
        page="about"
        title="About Circuit Center"
        subtitle="Your trusted directory for all things PCB. Connecting distributors, manufacturers, &amp; engineers since 2026"
      />

      {/*
        Body wrapper carries the light --theme-surface-bg. The persistent
        <BackdropLayer /> at App.tsx level extends 420px below the navbar; the
        band area above this body wrapper is transparent so the SVG shows
        through, then this wrapper covers the lower portion of the backdrop
        and provides the page surface for body content.
      */}
      <div className={styles.aboutBody}>

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
                <Icon name={s.icon} />
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
          {STAT_TILES.map((tile) => {
            // StatTicker is keyed by the resolved value so it mounts fresh and
            // animates 0 -> N the moment the totals land, instead of sitting
            // at whatever it had already counted to.
            //
            // `compactCount` returns null for anything that is not a real
            // count, which covers the case TypeScript cannot: the payload came
            // off the network, so a field renamed server-side is `undefined`
            // here and must show the dash rather than a confident "0".
            const value = stats ? compactCount(stats[tile.key]) : null
            return (
              <div key={tile.key} className={styles.aboutStat}>
                {value ? (
                  <StatTicker key={value.num} value={value.num} suffix={value.suffix} />
                ) : (
                  <span className={styles.aboutStatNum}>{NO_VALUE}</span>
                )}
                <span className={styles.aboutStatLabel}>{tile.label}</span>
              </div>
            )
          })}
        </div>
      </section>

      {/* (4) Why — full-bleed graphite over the caustic light field: the
          manifesto, the commitments rail, then the Founder's Deal. No
          entrance animation; the Founder block's ignition is the moment. */}
      <section className={styles.aboutWhy} aria-labelledby="about-why-title">
        <CausticField className={styles.aboutWhyField} />
        <div className={styles.aboutWhyInner}>
          <h2 id="about-why-title" className={styles.aboutWhyTitle}>
            Why Circuit Center?
          </h2>
          <p className={styles.aboutWhyDisplay}>
            The places engineers look for parts stopped competing years ago. We didn&rsquo;t.
          </p>
          <p className={styles.aboutWhyManifesto}>
            Circuit Center is new. It started in 2026, after two decades of the same few part-data
            aggregators going uncontested and growing comfortable. We don&rsquo;t sell parts. We make
            them findable, and we build the tools the incumbents never bothered to.
          </p>
          <ul className={styles.whyRail}>
            {WHY_RAIL.map((row) => (
              <li key={row.claim} className={styles.whyRow}>
                <span className={styles.whyPad} aria-hidden="true" />
                <h3 className={styles.whyClaim}>{row.claim}</h3>
                <p className={styles.whyBody}>{row.body}</p>
              </li>
            ))}
          </ul>
          <FounderDeal />
        </div>
      </section>

      {/* (5) CTA — a person, not a queue */}
      <section className={`${styles.aboutSection} ${styles.aboutCta}`}>
        <h2 className={styles.aboutSectionTitle}>Reach a person, not a queue.</h2>
        <p className={styles.aboutCtaSub}>
          Something new ships every day. Tell us what the directory should do next, or ask a rep to
          walk you through a board.
        </p>
        <div className={styles.aboutCtaActions}>
          <Link to="/contact" className={`${styles.glowBtn} ${styles.glowBtnGold}`}>
            Talk to us
          </Link>
          <Link to="/search" className={`${styles.glowBtn} ${styles.glowBtnGhost}`}>
            Browse parts
          </Link>
        </div>
      </section>

      </div>
    </motion.div>
  )
}
