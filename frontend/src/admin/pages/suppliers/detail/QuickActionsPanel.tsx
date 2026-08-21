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
   * True while a SYNC run is in flight — the run, not the socket, so it stays
   * true across a dropped connection. Drives the spinner and the label.
   */
  syncing?: boolean;
  /**
   * Opens the live catalog-import stream — same ownership rule as `onSync`,
   * and the same console renders it.
   */
  onImport?: () => void;
  /** True while an IMPORT run is in flight — same rule as `syncing`. */
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
            className={syncing ? styles.qaSpin : undefined}
          />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {syncIsPausable
              ? pausing
                ? 'Pausing…'
                : 'Pause sync'
              : syncing
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
          <Icon name="download-simple" className={importing ? styles.qaPulse : undefined} />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {importIsPausable
              ? pausing
                ? 'Pausing…'
                : 'Pause import'
              : importing
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
