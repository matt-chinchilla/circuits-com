/**
 * PreferredPartnersBanner — CSB v15
 *
 * Bicameral banner: left identity block + right rail of supplier rows.
 * Replaces v14's horizontal-scroll chip rail. Source: design-handoff-v10
 * (Claude Design 9r_j6EMPd9tCcmHpyADZRA / preferred-partners.html).
 *
 * Per-row 5-column grid (medallion · Company · Sales Contact · Phone · Email)
 * with a vertical copper bus in the left gutter of the rail (one via per row).
 *
 * Decisions baked in per user direction 2026-06-02:
 *   - Always expanded (no dropdown toggle).
 *   - Rep cell shows `contact_name` on a single line — no title row.
 */
import { useEffect, useRef, useState } from 'react';
import type { Supplier } from '@public/types/supplier';
import { useEntrance } from '@public/hooks/useEntrance';
import CircuitTraces from '@public/components/widgets/CircuitTraces';
import CopyAffordance from '@public/components/CopyAffordance';
import styles from './PreferredPartnersBanner.module.scss';

interface PreferredPartnersBannerProps {
  suppliers: Supplier[];
  categoryName?: string;
}

const NET_ENERGIZE_MS = 1500;

function lettermark(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'SP';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// RFC 3986–aware: prepend https:// unless already-schemed or protocol-relative.
// Mirrors admin/pages/suppliers/form.prependScheme — kept local for now; promote
// to @shared/utils/url.ts once a 3rd consumer needs it (parts form is the next).
function prependScheme(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return trimmed;
  return `https://${trimmed}`;
}

function displayHostname(url: string): string {
  try {
    return new URL(prependScheme(url)).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, '')}`;
}

function SupplierLogo({ supplier }: { supplier: Supplier }) {
  const [failed, setFailed] = useState(false);
  const src = supplier.logo_url?.trim() || '';
  if (!src || failed) {
    return <span className={styles.fbLettermark}>{lettermark(supplier.name)}</span>;
  }
  return (
    <img
      src={src}
      alt={`${supplier.name} logo`}
      className={styles.fbLogo}
      onError={() => {
        console.warn('[PreferredPartnersBanner] supplier logo failed to load', {
          supplier_id: supplier.id,
          name: supplier.name,
          logo_url: src,
        });
        setFailed(true);
      }}
    />
  );
}

export default function PreferredPartnersBanner({
  suppliers,
  categoryName,
}: PreferredPartnersBannerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeIndices, setActiveIndices] = useState<Set<number>>(new Set());
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      timersRef.current.forEach((handle) => clearTimeout(handle));
      timersRef.current.clear();
    },
    [],
  );

  const list = Array.isArray(suppliers) ? suppliers : [];
  const featured = list
    .filter((s) => s.is_featured)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  useEntrance(rootRef, featured.length);

  if (featured.length === 0) return null;

  const energize = (i: number) => {
    setActiveIndices((prev) => {
      const next = new Set(prev);
      next.add(i);
      return next;
    });
    const existing = timersRef.current.get(i);
    if (existing != null) clearTimeout(existing);
    const handle = setTimeout(() => {
      setActiveIndices((prev) => {
        const next = new Set(prev);
        next.delete(i);
        return next;
      });
      timersRef.current.delete(i);
    }, NET_ENERGIZE_MS);
    timersRef.current.set(i, handle);
  };

  const ariaLabel = categoryName
    ? `Preferred partners for ${categoryName}`
    : 'Preferred partners';

  return (
    <div
      ref={rootRef}
      className={styles.fb}
      data-tier="featured"
      data-expanded="true"
      role="region"
      aria-label={ariaLabel}
    >
      <div className={styles.fbCircuit} aria-hidden="true">
        {/*
          variant="static" — non-hero pages keep the gold trace lattice but skip
          electrons + 6s draw-in + IntersectionObserver bookkeeping. CLAUDE.md
          (Tier-3 #6 perf invariant 2026-04-19) names /category/* explicitly.
          variant="full" here doubled animation cost vs. the BackdropLayer's
          persistent full instance and was the smoking gun for hover-lag.
        */}
        <CircuitTraces variant="static" />
      </div>
      <span className={styles.fbRim} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidTl}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidTr}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidBl}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidBr}`} aria-hidden="true" />
      <span className={styles.fbDes} aria-hidden="true">CS1 &middot; PREFERRED PARTNERS</span>

      <div className={styles.fbId}>
        <span className={styles.fbKicker}>◆ Preferred Partners</span>
        <div className={styles.fbIdCount}>
          <span className={styles.fbCountNum}>{featured.length}</span>
          <span className={styles.fbCountLabel}>
            Featured suppliers
            {categoryName && <span>in {categoryName}</span>}
          </span>
        </div>
        <p className={styles.fbIdTag}>
          Authorized distributors sponsoring this category — ranked by partnership tier.
        </p>
        <a className={styles.fbCta} href="/keyword">
          Become a partner →
        </a>
      </div>

      <div className={styles.fbRail}>
        <div className={styles.fbHead} aria-hidden="true">
          <span className={styles.fbHeadCell} />
          <span className={styles.fbHeadCell}>Company</span>
          <span className={styles.fbHeadCell}>Sales Contact</span>
          <span className={styles.fbHeadCell}>Phone</span>
          <span className={styles.fbHeadCell}>Email</span>
        </div>

        <div className={styles.fbStackScroll}>
          <div className={styles.fbStack}>
            <span className={styles.fbBusLine} aria-hidden="true" />

            {featured.map((s, i) => {
              const isLive = activeIndices.has(i);
              // Refdes is positional (U1, U2 by stack order — silkscreen
              // designator convention). Rank chip is the DB rank — when an
              // admin unfeatures a higher-rank supplier, surviving rows keep
              // their semantic rank instead of silently renumbering, which
              // would contradict the subtitle "ranked by partnership tier".
              const refdesIndex = i + 1;
              const dbRank = s.rank ?? i + 1;
              return (
                <div
                  key={s.id}
                  data-enter
                  className={`${styles.fbChip} ${isLive ? styles.fbChipIsLive : ''}`}
                  onClick={() => energize(i)}
                >
                  <span
                    className={`${styles.fbVia} ${isLive ? styles.fbViaIsLive : ''}`}
                    aria-hidden="true"
                  />
                  <span className={styles.fbRefdes}>U{refdesIndex}</span>

                  <div className={styles.fbLogoBlock}>
                    <SupplierLogo supplier={s} />
                  </div>

                  <div className={`${styles.fbCol} ${styles.fbColCompany}`}>
                    <div className={styles.fbConame}>
                      <span className={styles.fbConameTxt}>{s.name}</span>
                      <span className={styles.fbRank}>#{dbRank}</span>
                    </div>
                    {s.website && (
                      <a
                        className={styles.fbSiteLink}
                        href={prependScheme(s.website)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className={styles.fbSubIcon} aria-hidden="true">⊕</span>
                        {displayHostname(s.website)}
                      </a>
                    )}
                  </div>

                  <div className={`${styles.fbCol} ${styles.fbColRep}`}>
                    <span className={styles.fbRepName}>
                      {s.contact_name || 'Sales team'}
                    </span>
                  </div>

                  <div className={`${styles.fbCol} ${styles.fbColPhone}`}>
                    {s.phone ? (
                      <span className={styles.fbFoot}>
                        <a
                          className={styles.fbSub}
                          href={telHref(s.phone)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.phone}
                        </a>
                        <CopyAffordance text={s.phone} compact />
                      </span>
                    ) : (
                      <span className={styles.fbEmpty}>—</span>
                    )}
                  </div>

                  <div className={`${styles.fbCol} ${styles.fbColEmail}`}>
                    {s.email ? (
                      <span className={styles.fbFoot}>
                        <a
                          className={styles.fbSub}
                          href={`mailto:${s.email}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.email}
                        </a>
                        <CopyAffordance text={s.email} compact />
                      </span>
                    ) : (
                      <span className={styles.fbEmpty}>—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
