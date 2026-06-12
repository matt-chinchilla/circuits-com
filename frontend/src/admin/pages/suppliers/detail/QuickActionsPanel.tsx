// Supplier-detail Quick Actions hero strip — full-width 4-card row directly
// below the page head. Each card stashes a supplier-context packet on the
// prefill bus and navigates, so the destination form lands half-filled.
// Aimed at non-technical staff doing bulk inventory entry where the same
// supplier shows up across many parts/sponsorships.
//
// The first card is the primary action (filled green) — it replaces the
// header "Add Part" button. The other three use blue/gold/purple tonal
// fills so the strip reads as a palette of distinct workflows.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import { setPrefill } from '@admin/services/prefillBus';
import type { AdminSupplier, Part } from '@admin/types/admin';
import styles from './QuickActionsPanel.module.scss';

interface Props {
  supplier: AdminSupplier;
  partRows: Part[];
  /** Called after the "Sync now" action so the parent can refresh stats. */
  onAfterSync?: (delta: number) => void;
}

type Tier = 'Featured' | 'Platinum' | 'Gold' | 'Silver';

function deriveTierLabel(parts_count: number | undefined): Tier {
  const n = parts_count ?? 0;
  if (n >= 200) return 'Featured';
  if (n >= 100) return 'Platinum';
  if (n >= 25) return 'Gold';
  return 'Silver';
}

export default function QuickActionsPanel({ supplier, partRows, onAfterSync }: Props) {
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState(false);

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

  const tierLabel = deriveTierLabel(supplier.parts_count);

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
      // The supplier's catalog tier (Featured for the biggest distributors) is
      // only a hint; sponsor tiers are Platinum/Gold/Silver, so map the merged
      // Featured→Platinum. The sponsor form re-corrects it to match placement.
      tier: tierLabel === 'Featured' ? 'Platinum' : tierLabel,
      category_id: smartCategoryId,
    });
    navigate('/admin/sponsors/new');
  };

  const handleImportCSV = () => {
    setPrefill('import', { supplier_id: supplier.id, supplier_name: supplier.name });
    navigate('/admin/import');
  };

  const handleSync = () => {
    if (syncing) return;
    setSyncing(true);
    // Client-side simulated catalog sync — production would hit the
    // supplier's distributor API and merge deltas. Bumps a fake count
    // so the UI reflects what a real flow would do; replace with a real
    // POST /api/suppliers/{id}/sync when the upstream API lands.
    window.setTimeout(() => {
      const delta = Math.floor(Math.random() * 40) + 8;
      setSyncing(false);
      onAfterSync?.(delta);
    }, 700);
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
        onClick={handleSync}
        disabled={syncing}
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
    </div>
  );
}
