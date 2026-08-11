// ExpenseBreakdownPanel — where a month's money actually goes.
//
// `/dashboard/expenses/breakdown` returns ONE row per category (vendors sharing
// a category are comma-joined), already sorted by amount desc, so the panel
// renders it straight through — no client-side regrouping that could drift from
// the chart above it.
//
// The share bars are DOM, not a chart: five labelled rows with a magnitude cue
// is a table with bars, and turning it into a second pie would compete with the
// sponsor mix for the same glance.
//
// The page hands down the CURRENT month; the header pager then owns any other
// month and fetches it here rather than lifting a second piece of month state
// into DashboardPage, which already juggles two independent comparator windows.

import { useEffect, useState } from 'react';
import Icon from '@shared/components/Icon';
import { adminApi } from '@admin/services/adminApi';
import type { ExpenseBreakdownRow, ExpensesBreakdown } from '@admin/types/admin';
import { expenseCategoryMeta } from '@admin/services/expenseCategories';
import { usd } from './format';
import { monthPagerState, pagerMonthLabel } from './monthPager';
import styles from '../DashboardPage.module.scss';

interface ExpenseBreakdownPanelProps {
  breakdown: ExpensesBreakdown | null;
  loading: boolean;
}

/** Is this line a list-price guess rather than an invoiced number?
 *
 *  The SERVER decides now, per response: a nightly job syncs real AWS and
 *  Stripe charges, and the moment one lands the category stops being an
 *  estimate. `EXPENSE_CATEGORY_META.estimated` is the fallback ONLY — it is
 *  static ("infrastructure is always a guess"), which was true before the sync
 *  existed and would now brand a settled AWS invoice as an estimate.
 *
 *  `??` not `||`: an explicit `false` from the server must win. */
function isEstimated(row: ExpenseBreakdownRow): boolean {
  return row.estimated ?? expenseCategoryMeta(row.category).estimated ?? false;
}

/** Native tooltip itemizing a comma-joined vendor cell, which truncates. */
function vendorTitle(row: ExpenseBreakdownRow): string | undefined {
  if (!row.vendors || row.vendors.length === 0) return undefined;
  return row.vendors
    .map((v) => `${v.vendor ?? 'Unattributed'} — ${usd(Number(v.amount) || 0)}`)
    .join('\n');
}

export default function ExpenseBreakdownPanel({
  breakdown,
  loading,
}: ExpenseBreakdownPanelProps) {
  // `null` = "whatever the page handed us" (the server's default month). A
  // non-null key is a pager pick and owns the fetch below.
  const [month, setMonth] = useState<string | null>(null);
  const [picked, setPicked] = useState<ExpensesBreakdown | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // A new payload from the page (first load, or the demo toggle) replaces the
  // whole widget, and drops a stale month pick with it.
  useEffect(() => {
    setMonth(null);
    setPicked(null);
    setFailed(false);
  }, [breakdown]);

  useEffect(() => {
    if (month === null) return;
    let cancelled = false;
    setPending(true);
    setFailed(false);
    // Drop the outgoing month's rows NOW. The header label flips the instant
    // the arrow is clicked (that IS the feedback), so holding the old rows
    // under it would print August's spend beneath a July heading — the panel
    // shows its ordinary loading state instead, exactly as it does on first
    // paint.
    setPicked(null);
    adminApi
      .getExpensesBreakdown(month)
      .then((data) => {
        if (cancelled) return;
        setPicked(data);
      })
      .catch(() => {
        if (cancelled) return;
        // Blank the stale month's rows rather than showing them under the new
        // month's heading; `months` below still comes off the page's payload,
        // so the pager stays usable to step back out.
        setPicked(null);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const view = month === null ? breakdown : picked;
  const rows = view?.categories ?? [];
  const total = Number(view?.total) || 0;
  const anyEstimated = rows.some(isEstimated);
  const busy = loading || pending;

  // `available_months` is independent of the month being served, so the pager
  // survives a failed fetch by falling back to the page's payload.
  const months = view?.available_months ?? breakdown?.available_months;
  const activeMonth = month ?? breakdown?.month ?? '';
  const pager = monthPagerState(months, activeMonth);
  const monthName = view?.label ?? (activeMonth ? pagerMonthLabel(activeMonth) : '');

  let emptyText = 'No costs logged for this month yet.';
  if (busy) emptyText = 'Loading costs…';
  else if (failed) emptyText = 'Could not load that month.';
  else if (pager.visible && monthName) emptyText = `No costs logged for ${monthName}.`;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Cost breakdown</h3>
          <p className={styles.panelSub}>
            {/* The pager IS the month readout when it is showing; repeating the
                month one line below it just reads as a stutter. */}
            {pager.visible ? 'By category' : <>{monthName || 'This month'} &middot; by category</>}
          </p>
        </div>
        <div className={styles.panelHeadActions}>
          {pager.visible && (
            <div className={styles.monthPager}>
              <button
                type="button"
                className={styles.monthPagerBtn}
                disabled={pager.older === null}
                aria-label={
                  pager.older ? `Show ${pagerMonthLabel(pager.older)}` : 'No earlier month'
                }
                onClick={() => {
                  if (pager.older) setMonth(pager.older);
                }}
              >
                &lsaquo;
              </button>
              <span className={styles.monthPagerLabel} aria-live="polite">
                {monthName}
              </span>
              <button
                type="button"
                className={styles.monthPagerBtn}
                disabled={pager.newer === null}
                aria-label={pager.newer ? `Show ${pagerMonthLabel(pager.newer)}` : 'No later month'}
                onClick={() => {
                  if (pager.newer) setMonth(pager.newer);
                }}
              >
                &rsaquo;
              </button>
            </div>
          )}
          <span className={styles.panelTotal}>{usd(total)}</span>
        </div>
      </div>
      <div className={styles.breakdown}>
        {rows.length === 0 ? (
          <div className={styles.empty}>{emptyText}</div>
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
                    {isEstimated(row) && <span className={styles.estTag}>est.</span>}
                  </div>
                  <div className={styles.breakdownVendor} title={vendorTitle(row)}>
                    {row.vendor || '—'}
                  </div>
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
