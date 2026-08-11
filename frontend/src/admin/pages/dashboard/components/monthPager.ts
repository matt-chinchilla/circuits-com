// Month-pager arithmetic for the cost breakdown.
//
// The panel walks `available_months` — the months that actually HOLD expense
// rows — never calendar math. That list is deliberately sparse (a month with no
// costs is not a destination; the site had no Stripe fees before it had Stripe)
// and the server caps it at 24, so "previous" means "the next entry along the
// list", not `month - 1`.
//
// Split out of the panel so it is testable without mounting React: the vitest
// harness here is unit-logic only.

/** `YYYY-MM` -> `August 2026`.
 *
 *  Deliberately NOT `format.monthLabel`, which is month-only (`August`) because
 *  it labels chart series inside one window. A pager that can cross a year
 *  boundary has to say which year it landed on. Built in UTC field-by-field:
 *  `new Date('2026-08')` is parsed as midnight UTC and RENDERED locally, which
 *  prints July for anyone west of Greenwich. */
export function pagerMonthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

export interface MonthPagerState {
  /** The next OLDER month key, or null at the oldest end. */
  older: string | null;
  /** The next NEWER month key, or null at the newest end. */
  newer: string | null;
  /** Whether the pager has anywhere to go at all. One month (or none) is not a
   *  pager, and it hides rather than rendering two dead arrows. */
  visible: boolean;
}

/**
 * The neighbours of `current` within `months`.
 *
 * Found by COMPARISON, not by index — `YYYY-MM` keys sort correctly as plain
 * strings, and the served month can legitimately be ABSENT from the list: the
 * endpoint defaults to the current month whether or not it holds rows, while
 * `available_months` only lists months that do. An `indexOf` there returns -1
 * and dead-ends both arrows with 24 months sitting available.
 *
 * Order-independent for the same reason — the contract says desc, and nothing
 * here relies on it.
 */
export function monthPagerState(
  months: readonly string[] | null | undefined,
  current: string | null | undefined,
): MonthPagerState {
  const key = current ?? '';
  let older: string | null = null;
  let newer: string | null = null;
  if (key) {
    for (const month of months ?? []) {
      if (!month) continue;
      // Greatest key below `current`, and least key above it.
      if (month < key && (older === null || month > older)) older = month;
      if (month > key && (newer === null || month < newer)) newer = month;
    }
  }
  return { older, newer, visible: older !== null || newer !== null };
}
