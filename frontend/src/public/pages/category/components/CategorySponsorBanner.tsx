import { useState, useRef, useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import type { Sponsor } from '@public/types/sponsor';
import styles from './CategorySponsorBanner.module.scss';

interface CategorySponsorBannerProps {
  sponsor: Sponsor | null;
  categoryName?: string;
}

function lettermark(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  // Empty/whitespace-only company → 'SP' so the pad doesn't render the
  // literal middle-dot fallback that reads as a render error.
  if (parts.length === 0) return 'SP';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CopyChip({ value, tone = 'dark' }: { value: string; tone?: 'dark' | 'light' }) {
  const [copied, setCopied] = useState(false);
  // Cancel the reset-timer on unmount AND on rapid re-click — otherwise a
  // route change within 1.4s of a copy fires setState on the unmounted
  // component, and rapid double-clicks stack timeouts whose latest expiry
  // races the user's perception of when the "Copied" affordance should clear.
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1400);
      },
      () => { /* clipboard denied — no-op, keep the link */ },
    );
  };
  return (
    <button
      type="button"
      className={`${styles.copyChip} ${tone === 'light' ? styles.copyChipLight : ''}`}
      onClick={onClick}
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
    >
      {copied ? <>&#10003; Copied</> : <>&#9112; Copy</>}
    </button>
  );
}

/**
 * Hidden routed copper revealed by the flashlight — wide banner aspect
 * (1200x200, sliced). Ported from design handoff v3 csb-shared.jsx BoardArt.
 * Painted on a CSS mask gated by --mx/--my, so the only per-frame work while
 * tracking the cursor is the mask-window translation; the SVG geometry is
 * static.
 */
function BoardArt() {
  return (
    <svg
      className={styles.art}
      viewBox="0 0 1200 200"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g>
        <path className={styles.trace} d="M40 40 H300 L320 60 H560 L580 40 H900 L920 60 H1160" />
        <path className={styles.trace} d="M40 100 H180 L200 120 H420 L440 100 H760 L780 120 H1160" />
        <path className={styles.trace} d="M40 160 H360 L380 140 H620 L640 160 H980 L1000 140 H1160" />
        <path className={styles.trace} d="M300 40 V100 M560 60 V160 M900 40 V120 M180 100 V160 M760 100 V40 M980 140 V60" />
      </g>
      <g>
        {(
          [
            [40, 40], [320, 60], [580, 40], [920, 60],
            [40, 100], [200, 120], [440, 100], [780, 120],
            [40, 160], [380, 140], [640, 160], [1000, 140],
            [1160, 40], [1160, 100], [1160, 160],
          ] as const
        ).map(([cx, cy]) => (
          <g key={`${cx}-${cy}`}>
            <circle className={styles.padCu} cx={cx} cy={cy} r="6" />
            <circle className={styles.hole} cx={cx} cy={cy} r="2.1" />
          </g>
        ))}
      </g>
    </svg>
  );
}

function BoardShell({
  tier,
  empty,
  children,
}: {
  tier?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  const boardRef = useRef<HTMLDivElement>(null);

  /**
   * Cursor flashlight — desktop-only (fine pointer + hover + motion allowed).
   * Touch/coarse-pointer gets a `display: none` on .reveal/.lamp via media
   * query, so we deliberately skip the touch-capture dance the sidebar
   * SponsorBlock does (the design intends the banner as a desktop-rich /
   * mobile-static piece, not a drag-revealable card).
   *
   * Per-frame work is bounded by a rAF lock; rect is cached on enter and
   * invalidated on scroll/resize so pointermove never reflows.
   */
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rect: DOMRect | null = null;
    let raf = 0;

    const onEnter = () => {
      rect = el.getBoundingClientRect();
      el.setAttribute('data-lit', 'true');
    };
    const onLeave = () => el.setAttribute('data-lit', 'false');
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      const r = rect ?? el.getBoundingClientRect();
      rect = r;
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty('--mx', `${x}px`);
        el.style.setProperty('--my', `${y}px`);
      });
    };
    const invalidate = () => { rect = null; };

    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('pointermove', onMove);
      window.addEventListener('scroll', invalidate, true);
      window.addEventListener('resize', invalidate);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      el.setAttribute('data-lit', 'false');
    };

    const sync = () => (fine.matches && !reduced.matches ? attach() : detach());
    sync();
    fine.addEventListener('change', sync);
    reduced.addEventListener('change', sync);

    return () => {
      detach();
      fine.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <motion.div
      ref={boardRef}
      className={`${styles.board} ${empty ? styles.boardEmpty : ''}`}
      data-tier={(tier ?? 'gold').toLowerCase()}
      data-lit="false"
      role="region"
      aria-label={empty ? 'Open category sponsor slot' : 'Featured category sponsor'}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' as const }}
    >
      <div className={styles.substrate} aria-hidden="true" />
      <div className={styles.reveal} aria-hidden="true"><BoardArt /></div>
      <div className={styles.lamp} aria-hidden="true" />
      <span className={styles.rim} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidTL}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidTR}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidBL}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidBR}`} aria-hidden="true" />
      <span className={styles.designator} aria-hidden="true">CS1 &middot; CATEGORY-SPONSOR</span>
      {children}
    </motion.div>
  );
}

export default function CategorySponsorBanner({
  sponsor,
  categoryName,
}: CategorySponsorBannerProps) {
  if (!sponsor) {
    const subject = encodeURIComponent(
      categoryName
        ? `Category Sponsorship Inquiry — ${categoryName}`
        : 'Category Sponsorship Inquiry',
    );
    return (
      <BoardShell empty>
        <div className={styles.id}>
          <span className={styles.kicker}>&#9670; Category Sponsor</span>
          <div className={styles.idTop}>
            <span className={styles.pad}><span className={styles.mark}>SP</span></span>
            <span className={styles.co}>
              <span className={styles.coName}>Sponsor this category</span>
              <span className={styles.coTag}>
                Top-of-page placement above the parts table. One slot per category &mdash; yours to claim.
              </span>
            </span>
          </div>
          <a className={styles.cta} href={`mailto:john@circuits.com?subject=${subject}`}>
            Become a sponsor &rarr;
          </a>
        </div>
        <div className={styles.rail}>
          <span className={styles.spine} aria-hidden="true" />
          <div className={styles.field}>
            <span className={styles.pLabel}><span className={styles.dot} />Company<span className={styles.pinNo}>P1</span></span>
            <span className={styles.val}>&mdash;</span>
            <span className={styles.sub}>Your brand here</span>
          </div>
          <div className={styles.field}>
            <span className={styles.pLabel}><span className={styles.dot} />Contact<span className={styles.pinNo}>P2</span></span>
            <span className={styles.val}>&mdash;</span>
            <span className={styles.sub}>Your sales rep</span>
          </div>
          <div className={styles.field}>
            <span className={styles.pLabel}><span className={styles.dot} />Phone<span className={styles.pinNo}>P3</span></span>
            <span className={styles.val}>&mdash;</span>
            <span className={styles.sub}>Direct line</span>
          </div>
          <div className={styles.field}>
            <span className={styles.pLabel}><span className={styles.dot} />Email<span className={styles.pinNo}>P4</span></span>
            <span className={styles.val}>&mdash;</span>
            <span className={styles.sub}>Buyer-facing inbox</span>
          </div>
        </div>
      </BoardShell>
    );
  }

  const company = sponsor.supplier_name;
  const blurb = sponsor.description || `Featured partner — sponsoring ${categoryName || 'this category'}`;
  const contactName = sponsor.contact_name || '—';
  const phone = sponsor.phone || '';
  const email = sponsor.email || '';
  // Hide the CTA outright when there's neither email nor website. Falling
  // back to href="#" scrolls the user to the top of the category page on
  // tap — a noisy regression vs no-button.
  const ctaHref = email
    ? `mailto:${email}?subject=${encodeURIComponent(`Inquiry from circuits.com — ${categoryName || 'category page'}`)}`
    : sponsor.website || null;
  const ctaIsExternal = !email && !!sponsor.website;

  return (
    <BoardShell tier={sponsor.tier}>
      <div className={styles.id}>
        <span className={styles.kicker}>&#9670; Category Sponsor</span>
        <div className={styles.idTop}>
          <span className={styles.pad}>
            {sponsor.image_url ? (
              <img src={sponsor.image_url} alt={`${company} logo`} className={styles.logo} />
            ) : (
              <span className={styles.mark}>{lettermark(company)}</span>
            )}
          </span>
          <span className={styles.co}>
            <span className={styles.coName}>{company}</span>
            <span className={styles.coTag}>{blurb}</span>
          </span>
        </div>
        {ctaHref && (
          <a
            className={styles.cta}
            href={ctaHref}
            {...(ctaIsExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            Contact rep &rarr;
          </a>
        )}
      </div>
      <div className={styles.rail}>
        <span className={styles.spine} aria-hidden="true" />

        <div className={styles.field}>
          <span className={styles.pLabel}><span className={styles.dot} />Company<span className={styles.pinNo}>P1</span></span>
          <span className={styles.val}>{company}</span>
          <span className={styles.sub}>Featured partner</span>
        </div>

        <div className={styles.field}>
          <span className={styles.pLabel}><span className={styles.dot} />Contact<span className={styles.pinNo}>P2</span></span>
          <span className={styles.val}>{contactName}</span>
          <span className={styles.sub}>{sponsor.contact_name ? 'Sales rep' : 'Your sales rep'}</span>
        </div>

        <div className={styles.field}>
          <span className={styles.pLabel}><span className={styles.dot} />Phone<span className={styles.pinNo}>P3</span></span>
          <span className={`${styles.val} ${styles.valMono}`}>
            {phone ? <a href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>{phone}</a> : <>&mdash;</>}
          </span>
          <span className={styles.rowFoot}>
            <span className={styles.sub}>Mon&ndash;Fri</span>
            {phone && <CopyChip value={phone} />}
          </span>
        </div>

        <div className={styles.field}>
          <span className={styles.pLabel}><span className={styles.dot} />Email<span className={styles.pinNo}>P4</span></span>
          <span className={`${styles.val} ${styles.valMono}`}>
            {email ? <a href={`mailto:${email}`}>{email}</a> : <>&mdash;</>}
          </span>
          <span className={styles.rowFoot}>
            <span className={styles.sub}>Direct inbox</span>
            {email && <CopyChip value={email} />}
          </span>
        </div>
      </div>
    </BoardShell>
  );
}
