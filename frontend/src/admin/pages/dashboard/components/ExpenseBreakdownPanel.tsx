// ExpenseBreakdownPanel — where this month's money actually goes.
//
// `/dashboard/expenses/breakdown` returns ONE row per category (vendors sharing
// a category are comma-joined), already sorted by amount desc, so the panel
// renders it straight through — no client-side regrouping that could drift from
// the chart above it.
//
// The share bars are DOM, not a chart: five labelled rows with a magnitude cue
// is a table with bars, and turning it into a second pie would compete with the
// sponsor mix for the same glance.

import Icon from '@shared/components/Icon';
import type { ExpensesBreakdown } from '@admin/types/admin';
import { expenseCategoryMeta } from '@admin/services/expenseCategories';
import { monthLabel, usd } from './format';
import styles from '../DashboardPage.module.scss';

interface ExpenseBreakdownPanelProps {
  breakdown: ExpensesBreakdown | null;
  loading: boolean;
}

export default function ExpenseBreakdownPanel({
  breakdown,
  loading,
}: ExpenseBreakdownPanelProps) {
  const rows = breakdown?.categories ?? [];
  const total = Number(breakdown?.total) || 0;
  const anyEstimated = rows.some((r) => expenseCategoryMeta(r.category).estimated);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Cost breakdown</h3>
          <p className={styles.panelSub}>
            {breakdown ? monthLabel(breakdown.month) : 'This month'} &middot; by category
          </p>
        </div>
        <span className={styles.panelTotal}>{usd(total)}</span>
      </div>
      <div className={styles.breakdown}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            {loading ? 'Loading costs…' : 'No costs logged for this month yet.'}
          </div>
        ) : (
          rows.map((row) => {
            const meta = expenseCategoryMeta(row.category);
            const amount = Number(row.amount) || 0;
            const share = total > 0 ? Math.min(100, (amount / total) * 100) : 0;
            return (
              <div key={row.category} className={styles.breakdownRow}>
                <span className={styles.breakdownIcon} style={{ color: meta.color }}>
                  <Icon name={meta.icon} />
                </span>
                <div className={styles.breakdownMain}>
                  <div className={styles.breakdownLabel}>
                    {row.label}
                    {meta.estimated && <span className={styles.estTag}>est.</span>}
                  </div>
                  <div className={styles.breakdownVendor}>{row.vendor || '—'}</div>
                  {/* Presentational magnitude cue; the number beside it is the
                      accessible value, so the bar is aria-hidden. */}
                  <div className={styles.breakdownTrack} aria-hidden="true">
                    <span
                      className={styles.breakdownBar}
                      style={{
                        width: `${share}%`,
                        background: `linear-gradient(90deg, ${meta.color}, color-mix(in srgb, ${meta.color} 55%, var(--a-card)))`,
                      }}
                    />
                  </div>
                </div>
                <span className={styles.breakdownAmount}>{usd(amount)}</span>
              </div>
            );
          })
        )}
      </div>
      {anyEstimated && (
        <p className={styles.panelNote}>
          Lines marked <strong>est.</strong> are list-price estimates, not invoiced
          actuals — metered usage only reconciles at month end.
        </p>
      )}
    </div>
  );
}
