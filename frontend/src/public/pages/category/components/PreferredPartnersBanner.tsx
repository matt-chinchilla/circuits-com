/**
 * PreferredPartnersBanner — CSB v14
 *
 * Replaces v13's CategorySponsorBanner + SupplierTable. Renders the design-handoff-v9
 * "fixed-banner" Concept A: a single ENIG-gold PCB-themed rail of supplier chips
 * (one per featured supplier), with the cursor flashlight + click-to-energize
 * interactions ported from the SponsorBlock language.
 *
 * IMPORTANT DIFFERENCES from the v9 source:
 *   - No left identity block (.fbId / kicker / pad / CTA) — the rail spans the
 *     full banner width and contains ONE chip per featured supplier.
 *   - Chip count is dynamic (= number of featured suppliers). v9 had 4 fixed
 *     "field" chips (Company / Contact / Phone / Email) for a single sponsor;
 *     v14 has N chips, one per supplier.
 *   - Horizontal scroll instead of a 4-column grid (chips have `min-width: 280px`
 *     and the rail scrolls horizontally when they exceed the banner width).
 *   - Empty state returns null (TODO: design empty state for future).
 *
 * Renders both for parent-category pages AND sub-category pages — the banner
 * self-gates on `suppliers.length === 0` so callers don't need an extra `isParent`
 * guard. SponsorBlock + TopPartners (sub-cat sidebar) are unchanged.
 */
import { useEffect, useRef, useState } from 'react';
import type { Supplier } from '@public/types/supplier';
import { useFlashlight } from '@public/hooks/useFlashlight';
import { useEntrance } from '@public/hooks/useEntrance';
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

function displayHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function telHref(phone: string): string {
  // Strip everything but digits + leading +, per RFC 3966.
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
        // Minimal observability — devtools surfaces this in the console so a
        // broken supplier CDN is distinguishable from a legitimate no-logo
        // path. The project has no centralized error sink (no Sentry/log
        // service); upgrade to a real error sink when one exists.
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

  // Drain every pending energize timer on unmount so a chip-click within
  // 1500ms of nav-away does not setState on an unmounted component. React 19
  // swallows the stale-setState warning but the leak is still real.
  useEffect(
    () => () => {
      timersRef.current.forEach((handle) => clearTimeout(handle));
      timersRef.current.clear();
    },
    [],
  );

  // Defense-in-depth: a missing/non-array `suppliers` (API shape drift,
  // future Pydantic strip) would explode `.filter().sort()` and the
  // ErrorBoundary would catch it for the whole page. Cheap insurance.
  const list = Array.isArray(suppliers) ? suppliers : [];

  // Filter to featured suppliers, sort by rank asc (lowest rank = highest priority).
  const featured = list
    .filter((s) => s.is_featured)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  // Hook order MUST be stable — call BEFORE the empty-state early return.
  useFlashlight(rootRef);
  useEntrance(rootRef, featured.length);

  // TODO: design an empty state for the no-featured-suppliers case (the v9
  // handoff has an "is-empty" tint we could lift, but the chip-per-supplier
  // model doesn't have an obvious "0 chips" rendering yet).
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
      data-lit="false"
      data-tier="featured"
      role="region"
      aria-label={ariaLabel}
    >
      <div className={styles.fbCircuit} aria-hidden="true" />
      <div className={styles.fbLamp} aria-hidden="true" />
      <span className={styles.fbRim} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidTl}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidTr}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidBl}`} aria-hidden="true" />
      <span className={`${styles.fbFid} ${styles.fbFidBr}`} aria-hidden="true" />
      <span className={styles.fbDes} aria-hidden="true">CS1 &middot; PREFERRED PARTNERS</span>

      <div className={styles.fbRail}>
        <div className={styles.fbBus} aria-hidden="true">
          <span className={styles.fbBusLine} />
          {featured.map((s, i) => (
            <span
              key={`via-${s.id}`}
              className={`${styles.fbVia} ${activeIndices.has(i) ? styles.fbViaIsLive : ''}`}
              style={{
                left: `calc(${((i + 0.5) / featured.length) * 100}%)`,
              }}
            />
          ))}
        </div>

        {featured.map((s, i) => {
          const isLive = activeIndices.has(i);
          return (
            <div
              key={s.id}
              data-enter
              className={`${styles.fbChip} ${isLive ? styles.fbChipIsLive : ''}`}
              onClick={() => energize(i)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  energize(i);
                }
              }}
              aria-label={`Energize ${s.name}`}
            >
              <span className={styles.fbRefdes}>U{i + 1}</span>

              <div className={styles.fbLogoBlock}>
                <SupplierLogo supplier={s} />
              </div>

              <div className={styles.fbConame}>{s.name}</div>

              {s.phone && (
                <div className={styles.fbFoot}>
                  <a
                    className={styles.fbSub}
                    href={telHref(s.phone)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.phone}
                  </a>
                  <CopyAffordance text={s.phone} tone="dark" />
                </div>
              )}

              {s.email && (
                <div className={styles.fbFoot}>
                  <a
                    className={styles.fbSub}
                    href={`mailto:${s.email}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.email}
                  </a>
                  <CopyAffordance text={s.email} tone="dark" />
                </div>
              )}

              {s.website && (
                <div className={styles.fbFoot}>
                  <a
                    className={styles.fbSub}
                    href={s.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {displayHostname(s.website)}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
