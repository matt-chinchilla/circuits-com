// Expense new/edit form.
//
// Hydration on edit goes through `listExpenses()` and finds the row: the
// backend exposes no per-id GET (same as sponsors), and the list is small
// enough that a detail endpoint would be dead weight.
//
// Dates are `<input type="date">` (`YYYY-MM-DD`) end to end — no Date objects,
// no parsing. The month defaults come from ET so a new line created at 9pm on
// the 31st does not land in next month (`toISOString().slice(0,10)` is UTC and
// would).

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_META,
  isExpenseCategory,
} from '@admin/services/expenseCategories';
import type { ExpenseCategory, ExpenseCreate } from '@admin/types/admin';
import styles from './ExpenseFormPage.module.scss';

interface FormState {
  category: ExpenseCategory;
  vendor: string;
  amount: string;
  description: string;
  period_start: string;
  period_end: string;
}

interface FormErrors {
  amount?: string;
  period_start?: string;
  period_end?: string;
}

/** First and last day of the CURRENT month in America/New_York, as
 *  `YYYY-MM-DD`. en-CA is the ISO-shaped locale; the explicit timeZone is what
 *  keeps this DST-safe and off UTC. */
function estMonthBounds(): { start: string; end: string } {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .split('-')
    .map(Number);
  // Day 0 of the next month is the last day of this one; built in UTC so a
  // local offset can never roll it back.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

function emptyForm(): FormState {
  const { start, end } = estMonthBounds();
  return {
    category: 'infrastructure',
    vendor: '',
    amount: '',
    description: '',
    period_start: start,
    period_end: end,
  };
}

export default function ExpenseFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    adminApi
      .listExpenses()
      .then((rows) => {
        if (cancelled) return;
        const existing = rows.find((r) => r.id === id);
        if (!existing) {
          setNotFound(true);
          return;
        }
        setForm({
          // A hand-inserted row outside the union falls back to `other` rather
          // than rendering a blank <select> that would then save nothing.
          category: isExpenseCategory(existing.category) ? existing.category : 'other',
          vendor: existing.vendor ?? '',
          // NUMERIC arrives as a string; String() covers both without a NaN.
          amount: existing.amount != null ? String(existing.amount) : '',
          description: existing.description ?? '',
          period_start: existing.period_start ?? '',
          period_end: existing.period_end ?? '',
        });
      })
      .catch((err) => {
        if (!cancelled) console.error('[ExpenseFormPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isEdit]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  function validate(): boolean {
    const e: FormErrors = {};
    const amount = Number(form.amount);
    if (!form.amount.trim() || Number.isNaN(amount) || amount < 0) {
      e.amount = 'Required (USD, 0 or more)';
    }
    if (!form.period_start) e.period_start = 'Required';
    if (!form.period_end) e.period_end = 'Required';
    // ISO dates compare lexically — no Date parsing needed. Mirrors the
    // router's own 422 so the admin is told before the round-trip.
    if (form.period_start && form.period_end && form.period_end < form.period_start) {
      e.period_end = 'Must not precede the start date';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function buildBody(): ExpenseCreate {
    return {
      category: form.category,
      vendor: form.vendor.trim() || null,
      amount: Number(form.amount),
      description: form.description.trim() || null,
      period_start: form.period_start,
      period_end: form.period_end,
    };
  }

  async function handleSubmit(e?: React.FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      if (isEdit && id) await adminApi.updateExpense(id, buildBody());
      else await adminApi.createExpense(buildBody());
      setToast(isEdit ? 'Expense updated' : 'Expense created');
      setTimeout(() => navigate('/admin/expenses'), 600);
    } catch (err) {
      console.error('[ExpenseFormPage] save failed', err);
      // Surfaces the router's own message (e.g. the period-order 422) when it
      // sends a string detail; falls back otherwise.
      setToast(apiErrorDetail(err) ?? 'Save failed — try again');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    setShowDeleteConfirm(false);
    try {
      await adminApi.deleteExpense(id);
      setToast('Expense deleted');
      setTimeout(() => navigate('/admin/expenses'), 500);
    } catch (err) {
      console.error('[ExpenseFormPage] delete failed', err);
      setToast('Delete failed — try again');
    }
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading expense…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          That expense no longer exists.{' '}
          <Link to="/admin/expenses" className={styles.backLink}>
            Back to Expenses
          </Link>
        </div>
      </div>
    );
  }

  const categoryHint = EXPENSE_CATEGORY_META[form.category].hint;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <Link to="/admin/expenses" className={styles.backLink}>
            <ChevronLeft size={14} strokeWidth={2} />
            Expenses
          </Link>
          <h1 className={styles.title}>{isEdit ? 'Edit Expense' : 'New Expense'}</h1>
          <p className={styles.subtitle}>
            {isEdit
              ? 'Update the amount, vendor or period this cost covers.'
              : 'Log a monthly operating cost. One row per vendor per month.'}
          </p>
        </div>
      </header>

      <form className={styles.formGrid} onSubmit={handleSubmit} noValidate>
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Cost</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="category">
                  Category <span className={styles.fieldReq}>*</span>
                </label>
                <div className={styles.selectWrap}>
                  <select
                    id="category"
                    className={styles.select}
                    value={form.category}
                    onChange={(e) => update('category', e.target.value as ExpenseCategory)}
                  >
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {EXPENSE_CATEGORY_META[c].label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className={styles.fieldHint}>{categoryHint}</p>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="vendor">
                  Vendor
                </label>
                <input
                  id="vendor"
                  type="text"
                  className={styles.textInput}
                  value={form.vendor}
                  onChange={(e) => update('vendor', e.target.value)}
                  placeholder="AWS"
                  maxLength={120}
                />
                <p className={styles.fieldHint}>
                  Who is billing us. Shown beside the category on the dashboard
                  breakdown.
                </p>
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="amount">
                Amount (USD) <span className={styles.fieldReq}>*</span>
              </label>
              <input
                id="amount"
                type="number"
                className={`${styles.textInput} ${styles.mono}`}
                value={form.amount}
                onChange={(e) => update('amount', e.target.value)}
                placeholder="21.23"
                min="0"
                step="0.01"
              />
              {errors.amount && <div className={styles.fieldError}>{errors.amount}</div>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="description">
                Description
              </label>
              <textarea
                id="description"
                className={styles.textArea}
                rows={3}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
                placeholder="t3.small on-demand + 30 GB gp3 + Elastic IP"
              />
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Period</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="period_start">
                  Start <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="period_start"
                  type="date"
                  className={styles.textInput}
                  value={form.period_start}
                  onChange={(e) => update('period_start', e.target.value)}
                />
                {errors.period_start && (
                  <div className={styles.fieldError}>{errors.period_start}</div>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="period_end">
                  End <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="period_end"
                  type="date"
                  className={styles.textInput}
                  value={form.period_end}
                  onChange={(e) => update('period_end', e.target.value)}
                />
                {errors.period_end && <div className={styles.fieldError}>{errors.period_end}</div>}
              </div>
            </div>
            <p className={styles.fieldHint}>
              The dashboard buckets a cost by its <strong>start</strong> month, so a
              line that spans a whole month should start on the 1st. Defaults to the
              current month.
            </p>
          </div>
        </section>

        <div className={styles.formActions}>
          {isEdit && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 size={14} strokeWidth={2} />
              Delete
            </button>
          )}
          <div className={styles.formActionsSpacer} />
          <Link to="/admin/expenses" className={`${styles.btn} ${styles.btnGhost}`}>
            Cancel
          </Link>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving}>
            <Check size={14} strokeWidth={2} />
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create expense'}
          </button>
        </div>
      </form>

      {showDeleteConfirm && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>Delete this expense?</h3>
            <p className={styles.modalBody}>
              It disappears from the cost chart and the monthly breakdown. This
              cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleDelete}
              >
                <Trash2 size={14} strokeWidth={2} />
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={styles.toast}>
          <Check size={16} strokeWidth={3} />
          {toast}
        </div>
      )}
    </div>
  );
}
