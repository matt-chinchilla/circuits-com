// OperatingCostsPanel — what this company spends, month by month.
//
// Two sources in one list, which is the point: the Silver/Gold/Platinum lines
// derived from their ACTIVE sponsorships (what they pay us) sit beside their
// own expense rows (what they pay everyone else). `kind` separates them on the
// wire so the subscription lines can be badged with their tier and nothing has
// to be guessed from the category text.
//
// The month pager is the staff breakdown's, down to the arithmetic
// (`../monthPager` walks `available_months`, never the calendar — a month with
// no rows is not a destination). The page hands down the current month; any
// other month is fetched here rather than lifting a second piece of month
// state into the shell.

import { useEffect, useState } from 'react';
import Icon from '@shared/components/Icon';
import { accountApi } from '@admin/services/accountApi';
import { tierColorSet } from '@admin/components/charts/chartTheme';
import { expenseCategoryLabel, expenseCategoryMeta } from '@admin/services/expenseCategories';
import { normalizeSponsorTier } from '@admin/services/sponsorTier';
import type { AccountCostLine, AccountOperatingCosts } from '@admin/types/account';
import { usd } from '../format';
import { monthPagerState, pagerMonthLabel } from '../monthPager';
import styles from '../../DashboardPage.module.scss';
import own from './CustomerPanels.module.scss';

interface OperatingCostsPanelProps {
  costs: AccountOperatingCosts | null;
  loading: boolean;
}

/** A subscription line's category IS its tier, so the row wears the tier's own
 *  colour on the bar; everything else takes its expense-category accent. */
function lineColor(line: AccountCostLine): string {
  if (line.kind === 'subscription') {
    return tierColorSet(line.category).base;
  }
  return expenseCategoryMeta(line.category).color;
}

function lineIcon(line: AccountCostLine): string {
  return line.kind === 'subscription' ? 'credit-card' : expenseCategoryMeta(line.category).icon;
}

export default function OperatingCostsPanel({ costs, loading }: OperatingCostsPanelProps) {
  // `null` = the month the page handed down. A non-null key is a pager pick
  // and owns the fetch below.
  const [month, setMonth] = useState<string | null>(null);
  const [picked, setPicked] = useState<AccountOperatingCosts | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMonth(null);
    setPicked(null);
    setFailed(false);
  }, [costs]);

  useEffect(() => {
    if (month === null) return;
    let cancelled = false;
    setPending(true);
    setFailed(false);
    // Drop the outgoing month's rows NOW: the header label flips the instant
    // the arrow is clicked, so holding the old ones under it would print one
    // month's spend beneath another month's heading.
    setPicked(null);
    accountApi
      .getAccountOperatingCosts(month)
      .then((data) => {
        if (cancelled) return;
        setPicked(data);
      })
      .catch(() => {
        if (cancelled) return;
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

  const view = month === null ? costs : picked;
  const lines = view?.lines ?? [];
  const total = Number(view?.total) || 0;
  const busy = loading || pending;

  // `available_months` is independent of the month being served, so the pager
  // survives a failed fetch by falling back to the page's payload.
  const months = view?.available_months ?? costs?.available_months;
  const activeMonth = month ?? costs?.month ?? '';
  const pager = monthPagerState(months, activeMonth);
  const monthName = activeMonth ? pagerMonthLabel(activeMonth) : '';

  let emptyText = 'No costs recorded for this month yet.';
  if (busy) emptyText = 'Loading costs…';
  else if (failed) emptyText = 'Could not load that month.';
  else if (pager.visible && monthName) emptyText = `No costs recorded for ${monthName}.`;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Operating costs</h3>
          <p className={styles.panelSub}>
            {pager.visible ? (
              'Sponsorships and your own expenses'
            ) : (
              <>{monthName || 'This month'} &middot; sponsorships and your own expenses</>
            )}
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
        {lines.length === 0 ? (
          <div className={styles.empty}>{emptyText}</div>
        ) : (
          lines.map((line, index) => {
            const amount = Number(line.amount) || 0;
            const share = total > 0 ? Math.min(100, (amount / total) * 100) : 0;
            const color = lineColor(line);
            const tier =
              line.kind === 'subscription' ? normalizeSponsorTier(line.category) : null;
            return (
              // Index-keyed: a company can hold two Silver placements, so
              // neither the category nor the vendor is unique within a month.
              <div key={`${line.kind}-${line.category}-${index}`} className={styles.breakdownRow}>
                <span className={styles.breakdownIcon} style={{ color }}>
                  <Icon name={lineIcon(line)} />
                </span>
                <div className={styles.breakdownMain}>
                  <div className={styles.breakdownLabel}>
                    {expenseCategoryLabel(line.category)}
                    {tier && (
                      <span
                        className={own.tierTag}
                        style={{ borderColor: tierColorSet(tier).base }}
                      >
                        {tier}
                      </span>
                    )}
                  </div>
                  <div className={styles.breakdownVendor}>{line.vendor || '—'}</div>
                  {/* Presentational magnitude cue; the number beside it is the
                      accessible value, so the bar is aria-hidden. */}
                  <div className={styles.breakdownTrack} aria-hidden="true">
                    <span
                      className={styles.breakdownBar}
                      style={{
                        width: `${share}%`,
                        background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 55%, var(--a-card)))`,
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
    </div>
  );
}
