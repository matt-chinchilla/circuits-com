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
// parts it does not. Only one stream may be open per page (the console below
// renders one run), so each disables while EITHER is going.

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
  /** True while that stream is open; drives the card's spinner + disabled state. */
  syncing?: boolean;
  /**
   * Opens the live catalog-import stream — same ownership rule as `onSync`,
   * and the same console renders it.
   */
  onImport?: () => void;
  /** True while the IMPORT stream is open. */
  importing?: boolean;
}

export default function QuickActionsPanel({
  supplier,
  partRows,
  onSync,
  syncing,
  onImport,
  importing,
}: Props) {
  const navigate = useNavigate();
  // One stream per page: the console shows ONE run, and two concurrent runs
  // would also race the same provider quota. Whichever started, both cards go
  // out of service until it ends.
  const feedBusy = Boolean(syncing || importing);

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
        onClick={onSync}
        disabled={feedBusy || !onSync}
      >
        <span className={styles.qaCardIcon}>
          <Icon
            name="arrows-clockwise"
            className={syncing ? styles.qaSpin : undefined}
          />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {syncing ? 'Syncing…' : 'Sync inventory'}
          </span>
          <span className={styles.qaCardHint}>
            Pull stock + price from <strong>{cardHostHint}</strong>
          </span>
        </span>
      </button>

      <button
        type="button"
        className={`${styles.qaCard} ${styles.qaCardRed}`}
        onClick={onImport}
        disabled={feedBusy || !onImport}
      >
        <span className={styles.qaCardIcon}>
          <Icon name="download-simple" className={importing ? styles.qaPulse : undefined} />
        </span>
        <span className={styles.qaCardBody}>
          <span className={styles.qaCardTitle}>
            {importing ? 'Importing…' : 'Import new parts'}
          </span>
          <span className={styles.qaCardHint}>
            Discover new inventory from <strong>{cardHostHint}</strong>
          </span>
        </span>
      </button>
    </div>
  );
}
