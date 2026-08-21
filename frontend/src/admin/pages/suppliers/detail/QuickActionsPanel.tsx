// Supplier-detail Quick Actions hero strip — full-width 5-card row directly
// below the page head. Each card stashes a supplier-context packet on the
// prefill bus and navigates, so the destination form lands half-filled.
// Aimed at non-technical staff doing bulk inventory entry where the same
// supplier shows up across many parts/sponsorships.
//
// The first card is the primary action (filled green) — it replaces the
// header "Add Part" button. The others use filled blue/gold/purple/red
// variants so the strip reads as a palette of distinct workflows.
//
// The last two cards start LIVE FEED RUNS rather than navigating: sync
// refreshes the listings this supplier already has, import goes looking for
// parts it does not. Only one run may be going per supplier — the SERVER
// enforces that (a second POST is a 409), and these cards mirror it, which is
// why `serverRunning` matters as much as the local spinners: a run this page
// is no longer streaming is still spending the day's provider quota, and a
// card that looked idle would invite a second click that can only be refused.

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import { setPrefill } from '@admin/services/prefillBus';
import type { AdminSupplier, Part } from '@admin/types/admin';
import { deriveSupplierTier, supplierTierLabel } from '../tier';
import styles from './QuickActionsPanel.module.scss';

interface Props {
  supplier: AdminSupplier;
  partRows: Part[];
  /**
   * Opens the live inventory-sync stream. The PARENT owns the request, the
   * event state and the console panel — this card is only the trigger, so the
   * feed survives anything that re-renders the strip.
   */
  onSync?: () => void;
  /**
   * True while this card's job is OCCUPIED: a sync run going server-side, or
   * this tab holding a socket on one — it stays true across a dropped
   * connection, because the run does. Locks the card. The SPINNER and the
   * "Syncing…" label need the stronger fact and read `serverRunning` too, so
   * that neither claims work during a probe or a replay.
   */
  syncing?: boolean;
  /**
   * Opens the live catalog-import stream — same ownership rule as `onSync`,
   * and the same console renders it.
   */
  onImport?: () => void;
  /** Same, for the IMPORT card — same rule as `syncing`. */
  importing?: boolean;
  /** Which run is in flight, from X-Feed-Run-Mode — decides which card
   *  becomes the Pause control (owner requirement 2026-08-21). */
  serverRunMode?: 'sync' | 'import' | null;
  /** Ask the active run to wind down at the next safe part. */
  onPause?: () => void;
  /** True between the pause click and the run's paused ending. */
  pausing?: boolean;
  /**
   * True while a run is going SERVER-SIDE, from the server's own answer (the
   * page's active-run probe / an open observer), not from whether this tab
   * happens to be reading it. Both cards stay out of service on it.
   */
  serverRunning?: boolean;
}

/**
 * The looping "downloading" glyph for an active import: a stream of arrows
 * falling into the tray and vanishing as they land. The Phosphor glyph is a
 * single font character, so its arrow cannot move independently of its tray
 * — this inline SVG redraws the same anatomy in two parts and animates only
 * the arrows. `currentColor` keeps it white on the filled red card exactly
 * like the font icon it stands in for.
 */
function ImportFallIcon() {
  return (
    <svg
      className={styles.qaFall}
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.75 15v3.75a1.5 1.5 0 0 0 1.5 1.5h11.5a1.5 1.5 0 0 0 1.5-1.5V15" />
      <g className={styles.qaFallArrow}>
        <path d="m8.7 6.5 3.3 3.4 3.3-3.4" />
      </g>
      <g className={`${styles.qaFallArrow} ${styles.qaFallArrowMid}`}>
        <path d="m8.7 6.5 3.3 3.4 3.3-3.4" />
      </g>
      <g className={`${styles.qaFallArrow} ${styles.qaFallArrowLate}`}>
        <path d="m8.7 6.5 3.3 3.4 3.3-3.4" />
      </g>
    </svg>
  );
}

export default function QuickActionsPanel({
  supplier,
  partRows,
  onSync,
  syncing,
  onImport,
  importing,
  serverRunMode,
  onPause,
  pausing,
  serverRunning,
}: Props) {
  const navigate = useNavigate();
  // One run per supplier, and the SERVER is the authority on that: two runs
  // would race the same rate-limited daily quota against the same rows, so
  // the second click is a 409. Reading `serverRunning` (not just the local
  // spinners) is what keeps the card honest after a dropped socket — the run
  // is still going, so the button must still be out of service.
  const feedBusy = Boolean(syncing || importing || serverRunning);
  // The card matching the ACTIVE run flips into a Pause control (a second
  // click winds the run down at the next safe part — for imports, the cursor
  // makes the next click a resume). The OTHER card stays out of service:
  // one run per supplier is a server-enforced 409.
  const syncIsPausable = feedBusy && serverRunMode === 'sync' && Boolean(onPause);
  const importIsPausable = feedBusy && serverRunMode === 'import' && Boolean(onPause);
  // "Syncing…" / "Importing…" — and the moving glyphs — claim WORK, so they
  // belong to a run the server says is going, not merely to an open socket.
  // The page holds a socket open while it probes for a run on load and while
  // it replays one that has already ended; both leave the cards out of
  // service (a click has nothing useful to do mid-replay), but neither is an
  // import in progress, and animating one there is the same false "it's still
  // running" the console used to show.
  const syncLive = Boolean(syncing && serverRunning);
  const importLive = Boolean(importing && serverRunning);

  // Smart-default category — whichever category this supplier already has
  // the most listings in. Falls back to empty for brand-new suppliers.
  const smartCategoryId = useMemo(() => {
    if (!partRows.length) return undefined;
    const counts: Record<string, number> = {};
    for (const p of partRows) {
      if (p.category_id) counts[p.category_id] = (counts[p.category_id] ?? 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top?.[0];
  }, [partRows]);

  const smartCategoryName = useMemo(() => {
    if (!smartCategoryId) return undefined;
    const hit = partRows.find((p) => p.category_id === smartCategoryId);
    if (!hit) return undefined;
    if (hit.parent_category_name && hit.category_name) {
      return `${hit.parent_category_name} · ${hit.category_name}`;
    }
    return hit.category_name ?? undefined;
  }, [smartCategoryId, partRows]);

  const tierLabel = supplierTierLabel(deriveSupplierTier(supplier.parts_count));

  const handleAddPart = () => {
    setPrefill('part', {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      manufacturer_name: supplier.name,
      category_id: smartCategoryId,
    });
    navigate('/admin/parts/new');
  };

  const handleAddSponsorship = () => {
    setPrefill('sponsor', {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      // The supplier's catalog-size tier is only a hint; the sponsor form
      // re-corrects it to match the chosen placement.
      tier: tierLabel,
      category_id: smartCategoryId,
    });
    navigate('/admin/sponsors/new');
  };

  const handleImportCSV = () => {
    setPrefill('import', { supplier_id: supplier.id, supplier_name: supplier.name });
    navigate('/admin/import');
  };

  const cardHostHint = supplier.website
    ? supplier.website.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    : supplier.name;

  return (
    <div className={styles.qaStrip}>
      <button
        type="button"
        data-tour="qa-add-part"
        className={`${styles.qaCard} ${styles.qaCardPrimary}`}
        onClick={handleAddPart}
      >
        <span className={styles.qaCardIcon}>
          <Icon name="package" />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>Add a part</span>
          <span className={styles.qaCardHint}>
            Pre-fills <strong>{supplier.name}</strong>
            {smartCategoryName ? ` · ${smartCategoryName}` : ''}
          </span>
        </span>
        <Icon name="arrow-right" className={styles.qaCardChev} />
      </button>

      <button
        type="button"
        data-tour="qa-import-csv"
        className={`${styles.qaCard} ${styles.qaCardBlue}`}
        onClick={handleImportCSV}
      >
        <span className={styles.qaCardIcon}>
          <Icon name="upload-simple" />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>Import CSV</span>
          <span className={styles.qaCardHint}>
            All rows auto-tagged to <strong>{supplier.name}</strong>
          </span>
        </span>
        <Icon name="arrow-right" className={styles.qaCardChev} />
      </button>

      <button
        type="button"
        data-tour="qa-add-sponsorship"
        className={`${styles.qaCard} ${styles.qaCardGold}`}
        onClick={handleAddSponsorship}
      >
        <span className={styles.qaCardIcon}>
          <Icon name="star" />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>Add sponsorship</span>
          <span className={styles.qaCardHint}>
            Pre-fills sponsor + tier (<strong>{tierLabel}</strong>)
          </span>
        </span>
        <Icon name="arrow-right" className={styles.qaCardChev} />
      </button>

      <button
        type="button"
        className={`${styles.qaCard} ${styles.qaCardPurple}`}
        onClick={syncIsPausable ? onPause : onSync}
        disabled={syncIsPausable ? pausing : feedBusy || !onSync}
      >
        <span className={styles.qaCardIcon}>
          <Icon
            name="arrows-clockwise"
            className={syncLive ? styles.qaSpin : undefined}
          />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {syncIsPausable
              ? pausing
                ? 'Pausing…'
                : 'Pause sync'
              : syncLive
                ? 'Syncing…'
                : 'Sync inventory'}
          </span>
          <span className={styles.qaCardHint}>
            Pull stock + price from <strong>{cardHostHint}</strong>
          </span>
        </span>
      </button>

      <button
        type="button"
        className={`${styles.qaCard} ${styles.qaCardRed}`}
        onClick={importIsPausable ? onPause : onImport}
        disabled={importIsPausable ? pausing : feedBusy || !onImport}
      >
        <span className={styles.qaCardIcon}>
          {importLive ? <ImportFallIcon /> : <Icon name="download-simple" />}
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {importIsPausable
              ? pausing
                ? 'Pausing…'
                : 'Pause import'
              : importLive
                ? 'Importing…'
                : 'Import new parts'}
          </span>
          <span className={styles.qaCardHint}>
            Discover new inventory from <strong>{cardHostHint}</strong>
          </span>
        </span>
      </button>
    </div>
  );
}
