// The CUSTOMER's expense book — their own operating costs, not ours.
//
// A separate component rather than a branch inside the staff list, for the
// reason every other split in this console exists: `adminApi.listExpenses()`
// is `require_staff`, so a customer who mounted the staff page would get one
// 403 and an empty table that looks like "you have no expenses". Not mounting
// it is the only version of hidden the network tab agrees with.
//
// What differs beyond the endpoint is the QUESTION. The staff page groups by
// category with filter chips, because it is auditing where the company's money
// goes across a fixed set of six vendors-of-ours. This is a ledger somebody
// keeps by hand: it bands by month, totals each band, and the categories are
// their own free text rather than our six — `expenseCategoryLabel` title-cases
// anything it does not recognise, so a customer's own word renders properly
// without being one of ours.
//
// The chrome is the staff list's, class for class (`ExpensesPage.module.scss`),
// so the two books read as one system.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { Pencil, Plus } from 'lucide-react';
import { accountApi } from '@admin/services/accountApi';
import { expenseCategoryLabel, expenseCategoryMeta } from '@admin/services/expenseCategories';
import Icon from '@shared/components/Icon';
import type { AccountExpense } from '@admin/types/account';
import { amountOf, dayLabel, groupByMonth } from './expenseMonths';
import styles from './ExpensesPage.module.scss';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `Aug 1 → Aug 31`, collapsed to a single day when the period is one day —
 *  which is what a line gets when the server defaults `period_end` to the
 *  start, so most rows read as one date instead of the same date twice. */
function periodText(expense: AccountExpense): string {
  const start = dayLabel(expense.period_start);
  const end = expense.period_end ? dayLabel(expense.period_end) : start;
  return start === end ? start : `${start} → ${end}`;
}

export default function CustomerExpensesPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const navigate = useNavigate();
  const [items, setItems] = useState<AccountExpense[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed read and an empty book are different sentences: one of them
  // invites a first row, the other must not.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountApi
      .listAccountExpenses()
      .then((page) => {
        if (!cancelled) setItems(page.items);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[CustomerExpensesPage] load failed', err);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const months = useMemo(() => groupByMonth(items), [items]);
  const total = useMemo(() => items.reduce((sum, e) => sum + amountOf(e), 0), [items]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Expenses</h1>
          <p className={styles.subtitle}>
            Your own operating costs, banded by month. Private to your account
            &mdash; Circuit Center staff do not see these lines, and they feed the
            Operating costs panel on your dashboard beside what your placements
            cost you.
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link
            to={consolePath('/admin/expenses/new')}
            className={`${styles.btn} ${styles.btnPrimary}`}
          >
            <Plus size={15} strokeWidth={2} />
            New Expense
          </Link>
        </div>
      </header>

      {loading && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>Loading your expenses&hellip;</div>
        </div>
      )}

      {!loading && failed && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            <strong className={styles.emptyStateTitle}>
              Your expenses could not be loaded.
            </strong>
            <span className={styles.emptyStateBody}>
              Nothing has been lost &mdash; reload the page to try again.
            </span>
          </div>
        </div>
      )}

      {!loading && !failed && items.length === 0 && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            <strong className={styles.emptyStateTitle}>Your book is empty.</strong>
            <span className={styles.emptyStateBody}>
              Log what you spend running your side of the catalog &mdash; a
              warehouse line, tooling, freight, the software you pay for. Each row
              is one vendor for one period, and only you can see it.
            </span>
            <Link
              to={consolePath('/admin/expenses/new')}
              className={`${styles.btn} ${styles.btnPrimary}`}
            >
              <Plus size={15} strokeWidth={2} />
              Add your first expense
            </Link>
          </div>
        </div>
      )}

      {!loading && !failed && items.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Vendor</th>
                  <th>Description</th>
                  <th>Period</th>
                  <th className={styles.numCol}>Amount</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              {months.map((month) => (
                <tbody key={month.key || 'undated'}>
                  <tr className={styles.monthRow}>
                    <th className={styles.monthLabel} colSpan={4} scope="rowgroup">
                      {month.label}
                    </th>
                    <td className={`${styles.numCol} ${styles.monthTotalCell}`}>
                      <span className={styles.footTotal}>{USD.format(month.total)}</span>
                    </td>
                    <td className={styles.monthTotalCell} />
                  </tr>
                  {month.lines.map((e) => {
                    const meta = expenseCategoryMeta(e.category);
                    return (
                      <tr key={e.id}>
                        <td>
                          <span className={styles.categoryCell}>
                            <Icon name={meta.icon} />
                            <span>{expenseCategoryLabel(e.category)}</span>
                          </span>
                        </td>
                        <td>
                          <strong>{e.vendor || '—'}</strong>
                        </td>
                        <td className={styles.descCell}>{e.description || '—'}</td>
                        <td>
                          <span className={styles.periodText}>{periodText(e)}</span>
                        </td>
                        <td className={styles.numCol}>
                          <span className={styles.amountText}>{USD.format(amountOf(e))}</span>
                        </td>
                        <td className={styles.rowActionsCell}>
                          <button
                            type="button"
                            className={styles.rowAction}
                            onClick={() => navigate(consolePath(`/admin/expenses/${e.id}/edit`))}
                            aria-label={`Edit ${expenseCategoryLabel(e.category)} expense`}
                          >
                            <Pencil size={14} strokeWidth={2} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <td colSpan={4} className={styles.footLabel}>
                    {items.length} {items.length === 1 ? 'line' : 'lines'} across{' '}
                    {months.length} {months.length === 1 ? 'month' : 'months'}
                  </td>
                  <td className={styles.numCol}>
                    <span className={styles.footTotal}>{USD.format(total)}</span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
