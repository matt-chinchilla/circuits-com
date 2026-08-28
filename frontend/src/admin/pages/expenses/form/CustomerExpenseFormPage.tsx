// New/edit for a line of the CUSTOMER's own expense book.
//
// The staff form's shape, class for class, with three differences that come
// from the contract rather than from taste:
//
//  1. CATEGORY IS FREE TEXT. The staff book is a `Literal` of six categories
//     because they are six bills we actually receive; a customer's costs are
//     theirs to name, so the server takes any trimmed, lowercased 1–30 chars.
//     The six are offered as a datalist — a suggestion, never a fence — and
//     `expenseCategoryLabel` renders whatever comes back.
//  2. AMOUNT MUST BE POSITIVE, to two decimals. The staff form allows 0
//     (a credited-to-zero month is a real staff row); this endpoint answers
//     422 for it, so the check happens here rather than as a round trip.
//  3. `period_end` IS OPTIONAL and defaults to `period_start` server-side, so
//     a one-day cost is one field, not the same date typed twice.
//
// Hydration on edit reads the LIST and finds the row, mirroring the staff form:
// the contract exposes no per-id GET, and a customer's book is small. A row
// that is not there — deleted, or never theirs — is the same "gone" screen,
// because the endpoint answers 404 for both and there is nothing else to say.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { accountApi } from '@admin/services/accountApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { EXPENSE_CATEGORIES } from '@admin/services/expenseCategories';
import type { AccountExpenseCreate } from '@admin/types/account';
import styles from './ExpenseFormPage.module.scss';

interface FormState {
  category: string;
  vendor: string;
  amount: string;
  description: string;
  period_start: string;
  period_end: string;
}

interface FormErrors {
  category?: string;
  amount?: string;
  period_start?: string;
  period_end?: string;
}

/** Today in America/New_York as `YYYY-MM-DD`. en-CA is the ISO-shaped locale;
 *  the explicit timeZone is what keeps this off UTC, where a line entered at
 *  9pm on the 31st would file itself into next month. */
function estToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function emptyForm(): FormState {
  return {
    category: '',
    vendor: '',
    amount: '',
    description: '',
    period_start: estToday(),
    period_end: '',
  };
}

export default function CustomerExpenseFormPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
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
    accountApi
      .listAccountExpenses()
      .then((page) => {
        if (cancelled) return;
        const existing = page.items.find((r) => r.id === id);
        if (!existing) {
          setNotFound(true);
          return;
        }
        setForm({
          category: existing.category ?? '',
          vendor: existing.vendor ?? '',
          // NUMERIC has been known to arrive as a string; String() covers both
          // without producing "NaN" in the input.
          amount: existing.amount != null ? String(existing.amount) : '',
          description: existing.description ?? '',
          period_start: existing.period_start ?? '',
          // Blank when it equals the start: the field is genuinely empty for a
          // one-day cost, and re-showing the default would make every edit
          // look like the user had typed a range.
          period_end:
            existing.period_end && existing.period_end !== existing.period_start
              ? existing.period_end
              : '',
        });
      })
      .catch((err) => {
        if (!cancelled) console.error('[CustomerExpenseFormPage] load failed', err);
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
    const category = form.category.trim();
    if (!category) e.category = 'Required';
    // Code points, like the server's own length check.
    else if ([...category].length > 30) e.category = 'Keep it to 30 characters';

    const amount = Number(form.amount);
    if (!form.amount.trim() || !Number.isFinite(amount) || amount <= 0) {
      e.amount = 'Required (USD, more than zero)';
    } else if (!/^\d*(\.\d{1,2})?$/.test(form.amount.trim())) {
      // The column is NUMERIC(_, 2) — a third decimal is rounded away
      // silently, so it is refused here while the typed number is still on
      // screen to correct. Checked as TEXT, not by multiplying by 100: 0.07
      // times 100 is 7.000000000000001 in binary floating point, and that
      // arithmetic would reject a perfectly good seven-cent line.
      e.amount = 'Use dollars and cents, e.g. 129.00';
    }

    if (!form.period_start) e.period_start = 'Required';
    // ISO dates compare lexically — no Date parsing needed.
    if (form.period_end && form.period_start && form.period_end < form.period_start) {
      e.period_end = 'Must not precede the start date';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  /**
   * The body for both verbs, differing in ONE field.
   *
   * On create an empty End is OMITTED, so the server applies its own "same day
   * as the start" default rather than this form inventing a range. On edit it
   * cannot be omitted: a PATCH leaves an absent field untouched, so clearing
   * the End box would silently keep yesterday's range — the collapse has to be
   * stated as `period_end = period_start`.
   */
  function buildBody(forEdit: boolean): AccountExpenseCreate {
    const body: AccountExpenseCreate = {
      category: form.category.trim().toLowerCase(),
      amount: Number(form.amount),
      period_start: form.period_start,
      vendor: form.vendor.trim() || null,
      description: form.description.trim() || null,
    };
    if (form.period_end) body.period_end = form.period_end;
    else if (forEdit) body.period_end = form.period_start;
    return body;
  }

  async function handleSubmit(e?: React.FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      if (isEdit && id) {
        // Every editable field, which a partial body permits; an omitted key
        // would mean "leave it", and this form owns all of them.
        await accountApi.updateAccountExpense(id, buildBody(true));
      } else {
        await accountApi.createAccountExpense(buildBody(false));
      }
      setToast(isEdit ? 'Expense updated' : 'Expense created');
      setTimeout(() => navigate(consolePath('/admin/expenses')), 600);
    } catch (err) {
      console.error('[CustomerExpenseFormPage] save failed', err);
      // Surfaces the router's own message when it sends a string detail;
      // falls back otherwise (a 422's detail is an ARRAY and would crash as a
      // React child — `apiErrorDetail` is what keeps that out).
      setToast(apiErrorDetail(err) ?? 'Save failed — check the amount and try again');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    setShowDeleteConfirm(false);
    try {
      await accountApi.deleteAccountExpense(id);
      setToast('Expense deleted');
      setTimeout(() => navigate(consolePath('/admin/expenses')), 500);
    } catch (err) {
      console.error('[CustomerExpenseFormPage] delete failed', err);
      setToast(apiErrorDetail(err) ?? 'Delete failed — try again');
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
          <Link to={consolePath('/admin/expenses')} className={styles.backLink}>
            Back to Expenses
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <Link to={consolePath('/admin/expenses')} className={styles.backLink}>
            <ChevronLeft size={14} strokeWidth={2} />
            Expenses
          </Link>
          <h1 className={styles.title}>{isEdit ? 'Edit Expense' : 'New Expense'}</h1>
          <p className={styles.subtitle}>
            {isEdit
              ? 'Update the amount, vendor or period this cost covers.'
              : 'Log one of your own operating costs. Private to your account.'}
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
                <input
                  id="category"
                  type="text"
                  className={styles.textInput}
                  value={form.category}
                  onChange={(e) => update('category', e.target.value)}
                  placeholder="freight"
                  list="account-expense-categories"
                  maxLength={30}
                />
                {/* Suggestions, not a fence: the endpoint takes any short
                    label, and the six below are only the ones this console
                    already draws a glyph for. */}
                <datalist id="account-expense-categories">
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                {errors.category && <div className={styles.fieldError}>{errors.category}</div>}
                <p className={styles.fieldHint}>
                  Your own label, up to 30 characters. Lines sharing a category
                  group together on your dashboard.
                </p>
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
                  placeholder="Who billed you"
                  maxLength={120}
                />
                <p className={styles.fieldHint}>Shown beside the category in your book.</p>
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
                placeholder="129.00"
                min="0.01"
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
                placeholder="What this covered"
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
                  End
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
              Your book bands by the <strong>start</strong> month, so a cost that
              covers a whole month should start on the 1st. Leave the end blank
              for a one-day cost.
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
          <Link to={consolePath('/admin/expenses')} className={`${styles.btn} ${styles.btnGhost}`}>
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
              It leaves your book and your dashboard&rsquo;s operating costs. This
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
