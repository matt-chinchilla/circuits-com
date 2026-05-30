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

function BoardShell({
  tier,
  empty,
  children,
}: {
  tier?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`${styles.board} ${empty ? styles.boardEmpty : ''}`}
      data-tier={(tier ?? 'gold').toLowerCase()}
      role="region"
      aria-label={empty ? 'Open category sponsor slot' : 'Featured category sponsor'}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' as const }}
    >
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
