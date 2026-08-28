// Expenses list — the cost side of the P&L, managed by hand.
//
// Mirrors the Sponsors list: fetch on mount with a cancel flag, category chips
// + inline search over a single table, and a per-row pencil into the form.
// The server already orders newest period first, so there is no client sort.
//
// GOTCHA (CLAUDE.md, NUMERIC-string): `AdminExpense.amount` is TYPED `number`
// but arrives as a JSON STRING ("21.23") because Postgres serializes NUMERIC
// that way. Everything numeric below goes through `amountOf()` — a raw
// comparison would string-compare ("9" > "10").

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { Pencil, Plus, Search, X } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { useAuth } from '@admin/contexts/AuthContext';
import {
  EXPENSE_CATEGORIES,
  expenseCategoryLabel,
  expenseCategoryMeta,
} from '@admin/services/expenseCategories';
import Icon from '@shared/components/Icon';
import type { AdminExpense, ExpenseCategory } from '@admin/types/admin';
import CustomerExpensesPage from './CustomerExpensesPage';
import styles from './ExpensesPage.module.scss';

type CategoryFilter = 'All' | ExpenseCategory;

const CATEGORY_FILTERS: CategoryFilter[] = ['All', ...EXPENSE_CATEGORIES];

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function amountOf(expense: AdminExpense): number {
  const n = Number(expense.amount);
  return Number.isFinite(n) ? n : 0;
}

/** `2026-07-01` -> `Jul 1, 2026`. Split by hand and rebuilt in UTC: passing the
 *  string to `new Date()` parses it as midnight UTC and then renders it in the
 *  local zone, printing the previous day west of Greenwich. */
function formatDate(ymd: string | null): string {
  if (!ymd) return '—';
  const [year, month, day] = ymd.split('-').map(Number);
  if (!year || !month || !day) return ymd;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function StaffExpensesPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const navigate = useNavigate();
  const [expenses, setExpenses] = useState<AdminExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminApi
      .listExpenses()
      .then((rows) => {
        if (!cancelled) setExpenses(rows);
      })
      .catch((err) => {
        if (!cancelled) console.error('[ExpensesPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const map: Record<string, number> = { All: expenses.length };
    for (const c of EXPENSE_CATEGORIES) map[c] = 0;
    for (const e of expenses) {
      const key = (e.category ?? '').trim().toLowerCase();
      if (key in map) map[key] += 1;
    }
    return map;
  }, [expenses]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      const key = (e.category ?? '').trim().toLowerCase();
      if (categoryFilter !== 'All' && key !== categoryFilter) return false;
      if (!q) return true;
      return [e.vendor ?? '', e.description ?? '', expenseCategoryLabel(e.category)]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [expenses, categoryFilter, search]);

  const visibleTotal = visible.reduce((sum, e) => sum + amountOf(e), 0);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Expenses</h1>
          <p className={styles.subtitle}>
            Monthly recurring operating costs &mdash; hosting, LLM usage, payment
            fees, mail and the domain. These feed the dashboard&rsquo;s cost chart.
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to={consolePath('/admin/expenses/new')} className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={15} strokeWidth={2} />
            New Expense
          </Link>
        </div>
      </header>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {CATEGORY_FILTERS.map((c) => (
            <button
              key={c}
              type="button"
              className={`${styles.filterChip} ${categoryFilter === c ? styles.filterChipActive : ''}`}
              onClick={() => setCategoryFilter(c)}
            >
              {c === 'All' ? 'All' : expenseCategoryLabel(c)}
              <span className={styles.chipCount}>{counts[c] ?? 0}</span>
            </button>
          ))}
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search vendor or description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

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
            <tbody>
              {visible.map((e) => {
                const meta = expenseCategoryMeta(e.category);
                return (
                  <tr key={e.id}>
                    <td>
                      <span className={styles.categoryCell}>
                        <Icon name={meta.icon} />
                        <span>{expenseCategoryLabel(e.category)}</span>
                        {/* Row-driven, not meta-driven: an AWS actual must not
                            wear the badge its category used to earn. */}
                        {e.source === 'estimate' && <span className={styles.estTag}>est.</span>}
                      </span>
                    </td>
                    <td>
                      <strong>{e.vendor || '—'}</strong>
                      {e.source !== 'manual' && e.source !== 'estimate' && (
                        <span className={styles.estTag} title="Written by the cost sync — editing takes ownership; deleting is refused.">
                          {'auto · '}
                          {e.source}
                        </span>
                      )}
                    </td>
                    <td className={styles.descCell}>{e.description || '—'}</td>
                    <td>
                      <span className={styles.periodText}>
                        {formatDate(e.period_start)}{' '}
                        <span className={styles.periodArrow}>&rarr;</span>{' '}
                        {formatDate(e.period_end)}
                      </span>
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
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className={styles.emptyRow}>
                    {loading
                      ? 'Loading expenses…'
                      : expenses.length === 0
                        ? 'No expenses logged. Click + New Expense to add the first line.'
                        : 'No expenses match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={4} className={styles.footLabel}>
                    {visible.length} {visible.length === 1 ? 'line' : 'lines'}
                  </td>
                  <td className={styles.numCol}>
                    <span className={styles.footTotal}>{USD.format(visibleTotal)}</span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

// The route component. A customer's book is a different table's slice behind a
// different router (`/api/account/expenses`, theirs alone) — see
// CustomerExpensesPage. The staff body above is unchanged by the split.
export default function ExpensesPage() {
  const { isCustomer } = useAuth();
  return isCustomer ? <CustomerExpensesPage /> : <StaffExpensesPage />;
}
