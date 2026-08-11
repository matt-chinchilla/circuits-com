// Expense category metadata — the ONE client-side home for the six categories
// the backend accepts (`app/models/expense.EXPENSE_CATEGORIES`, enforced as a
// Pydantic `Literal` so a bad value is a clean 422).
//
// Shared by the /admin/expenses CRUD page and the dashboard cost breakdown, so
// a category renders with the same label and glyph in both places. The server
// also sends a `label` on `/dashboard/expenses/breakdown`; that stays
// authoritative for anything it returns (including hand-inserted rows outside
// this union) and these labels cover the admin-side forms and lists.

import type { ExpenseCategory } from '@admin/types/admin';

export interface ExpenseCategoryMeta {
  label: string;
  /** Phosphor Light glyph, rendered via <Icon name={...} />. Never as text. */
  icon: string;
  /** What this line actually is, shown as the form's category hint. */
  hint: string;
  /** True when the amount is a list-price ESTIMATE rather than an invoiced
   *  actual — AWS is metered and only reconciles at month end, so the
   *  dashboard tags it rather than implying a settled number.
   *
   *  FALLBACK ONLY as of the cost sync: `/dashboard/expenses/breakdown` now
   *  sends `estimated` PER CATEGORY, computed from the source of every row
   *  behind it, and a category holding a real synced AWS/Stripe charge is not
   *  an estimate however this static flag reads. Prefer the response; use this
   *  when the payload predates the flag (demo data, an older cached reply). */
  estimated?: boolean;
  /** Vibrant categorical accent for the cost-breakdown row (bar + icon). A
   *  distinct hue per category so the breakdown reads as a spectrum, not a
   *  single amber wash. */
  color: string;
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'infrastructure',
  'ai',
  'payment',
  'email',
  'domain',
  'other',
];

export const EXPENSE_CATEGORY_META: Record<ExpenseCategory, ExpenseCategoryMeta> = {
  infrastructure: {
    label: 'Infrastructure',
    icon: 'cloud',
    hint: 'EC2, EBS, data transfer, Elastic IP — the AWS bill.',
    estimated: true,
    color: '#2563eb', // blue
  },
  ai: {
    label: 'AI / LLM',
    icon: 'sparkle',
    hint: 'Model usage — the Claude bill and any other inference spend.',
    color: '#7c3aed', // violet
  },
  payment: {
    label: 'Payment Processing',
    icon: 'credit-card',
    hint: 'Processor percentage + per-transaction fees.',
    color: '#0e9f6e', // emerald
  },
  email: {
    label: 'Email',
    icon: 'envelope-simple',
    hint: 'The mail server (its AWS bill syncs here) + the transactional relay.',
    color: '#0ea5e9', // sky
  },
  domain: {
    label: 'Domain',
    icon: 'globe-simple',
    hint: 'Registration and DNS, amortized to a monthly figure.',
    color: '#e8c252', // brand gold
  },
  other: {
    label: 'Other',
    icon: 'dots-three-circle',
    hint: 'Anything that does not fit a line above.',
    color: '#64748b', // slate
  },
};

/** Narrow an untrusted string (a hand-inserted DB row) to the union. */
export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return (
    typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Meta for a stored category, falling back to `other` so an unknown value
 *  still renders a glyph instead of an empty cell. */
export function expenseCategoryMeta(category: string | null | undefined): ExpenseCategoryMeta {
  const key = (category ?? '').trim().toLowerCase();
  return isExpenseCategory(key) ? EXPENSE_CATEGORY_META[key] : EXPENSE_CATEGORY_META.other;
}

/** Display label for a stored category — title-cases anything unrecognized,
 *  mirroring the server's `expense_category_label`. */
export function expenseCategoryLabel(category: string | null | undefined): string {
  const key = (category ?? '').trim().toLowerCase();
  if (isExpenseCategory(key)) return EXPENSE_CATEGORY_META[key].label;
  if (!key) return EXPENSE_CATEGORY_META.other.label;
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
