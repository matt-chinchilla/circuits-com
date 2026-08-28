// Month banding for the customer's expense book.
//
// The staff book groups by CATEGORY, because its question is "where does the
// company's money go". A customer's own book is a ledger they are keeping, and
// the question a ledger answers is "what did I spend in August" — so the rows
// band by the month of `period_start`, which is also the month the rest of the
// console files a cost under (the dashboard's cost breakdown buckets on the
// start month, never the end).
//
// Pure functions in their own module so the grouping is testable without
// mounting a page: the date handling below is the part that breaks silently.

import type { AccountExpense } from '@admin/types/account';

/** A month band: its rows, in the order the server sent them, and their sum. */
export interface ExpenseMonth {
  /** `YYYY-MM`, or `''` for rows with no usable `period_start`. */
  key: string;
  /** `August 2026`, or `Undated`. */
  label: string;
  lines: AccountExpense[];
  total: number;
}

/**
 * `amount` as a number, whatever the wire sent.
 *
 * Typed `number` on the account contract and a STRING on the staff one, both
 * from the same NUMERIC column (CLAUDE.md). Anything unparseable sinks to 0
 * rather than poisoning a month total with NaN — a total that reads `$NaN` is
 * worse than one line silently reading zero, and the row still shows its own
 * raw value.
 */
export function amountOf(expense: Pick<AccountExpense, 'amount'>): number {
  const n = Number(expense.amount);
  return Number.isFinite(n) ? n : 0;
}

/** `2026-08-14` → `2026-08`. Anything that is not an ISO date is `''`. */
export function monthKey(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return ymd.slice(0, 7);
}

/**
 * `2026-08` → `August 2026`.
 *
 * Built in UTC and rendered in UTC. `new Date('2026-08')` parses as midnight
 * UTC and then prints in the local zone, which west of Greenwich names the
 * PREVIOUS month — the same trap the staff list's `formatDate` sidesteps.
 */
export function monthLabel(key: string): string {
  if (!key) return 'Undated';
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * `2026-08-14` → `Aug 14`. The day inside a band whose header already carries
 * the year, so repeating it in every row would be noise.
 */
export function dayLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '—';
  const [year, month, day] = ymd.split('-').map(Number);
  if (!year || !month || !day) return ymd;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Rows → month bands, newest month first, undated rows last.
 *
 * The server already sends newest `period_start` first, so this could lean on
 * arrival order — it deliberately does not. Sorting the KEYS is two lines and
 * makes the grouping correct for any order, including the one a freshly
 * created row lands in when the list is patched locally rather than refetched.
 * Within a band the server's order is preserved.
 */
export function groupByMonth(items: AccountExpense[]): ExpenseMonth[] {
  const bands = new Map<string, AccountExpense[]>();
  for (const item of items) {
    const key = monthKey(item.period_start);
    const existing = bands.get(key);
    if (existing) existing.push(item);
    else bands.set(key, [item]);
  }
  // `''` sorts before every real key, so undated rows are moved to the end by
  // hand rather than by the comparator.
  const keys = [...bands.keys()].sort().reverse();
  const undated = keys.indexOf('');
  if (undated !== -1) keys.push(...keys.splice(undated, 1));

  return keys.map((key) => {
    const lines = bands.get(key) ?? [];
    return {
      key,
      label: monthLabel(key),
      lines,
      total: lines.reduce((sum, line) => sum + amountOf(line), 0),
    };
  });
}
