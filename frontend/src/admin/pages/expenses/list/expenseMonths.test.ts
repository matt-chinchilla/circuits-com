import { describe, expect, it } from 'vitest';
import type { AccountExpense } from '@admin/types/account';
import { amountOf, dayLabel, groupByMonth, monthKey, monthLabel } from './expenseMonths';

function line(overrides: Partial<AccountExpense>): AccountExpense {
  return {
    id: overrides.id ?? 'id',
    category: overrides.category ?? 'other',
    vendor: overrides.vendor ?? null,
    amount: overrides.amount ?? 0,
    period_start: overrides.period_start ?? '2026-08-01',
    period_end: overrides.period_end ?? null,
    description: overrides.description ?? null,
  };
}

describe('amountOf', () => {
  it('reads a JSON number', () => {
    expect(amountOf(line({ amount: 12.5 }))).toBe(12.5);
  });

  it('reads the NUMERIC string the same column sends on the staff contract', () => {
    // TS says number, Postgres has been known to say "12.50".
    expect(amountOf({ amount: '12.50' as unknown as number })).toBe(12.5);
  });

  it('sinks an unparseable amount to 0 rather than NaN', () => {
    expect(amountOf({ amount: 'n/a' as unknown as number })).toBe(0);
  });
});

describe('monthKey', () => {
  it('takes the year and month of an ISO date', () => {
    expect(monthKey('2026-08-14')).toBe('2026-08');
  });

  it('refuses anything that is not an ISO date', () => {
    expect(monthKey(null)).toBe('');
    expect(monthKey('')).toBe('');
    expect(monthKey('August 2026')).toBe('');
  });
});

describe('monthLabel', () => {
  it('names the month the key actually holds, not the local-zone one', () => {
    // The bug this pins: parsing as UTC and printing locally names July west
    // of Greenwich.
    expect(monthLabel('2026-08')).toBe('August 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
  });

  it('calls the no-date band Undated', () => {
    expect(monthLabel('')).toBe('Undated');
  });
});

describe('dayLabel', () => {
  it('renders the stored day, in UTC', () => {
    expect(dayLabel('2026-08-01')).toBe('Aug 1');
  });

  it('renders an em dash for a missing date', () => {
    expect(dayLabel(null)).toBe('—');
  });
});

describe('groupByMonth', () => {
  it('bands rows by the month of period_start, newest month first', () => {
    const bands = groupByMonth([
      line({ id: 'a', period_start: '2026-07-02', amount: 10 }),
      line({ id: 'b', period_start: '2026-08-01', amount: 20 }),
      line({ id: 'c', period_start: '2026-08-14', amount: 5 }),
    ]);
    expect(bands.map((b) => b.key)).toEqual(['2026-08', '2026-07']);
    expect(bands[0].lines.map((l) => l.id)).toEqual(['b', 'c']);
    expect(bands[0].total).toBe(25);
    expect(bands[1].total).toBe(10);
  });

  it('orders months by their key, not by arrival order', () => {
    const bands = groupByMonth([
      line({ id: 'old', period_start: '2025-12-01' }),
      line({ id: 'new', period_start: '2026-02-01' }),
      line({ id: 'mid', period_start: '2026-01-01' }),
    ]);
    expect(bands.map((b) => b.key)).toEqual(['2026-02', '2026-01', '2025-12']);
  });

  it('puts undated rows last instead of first', () => {
    // '' sorts ahead of every real key — the band would lead the page if the
    // comparator were left to decide.
    const bands = groupByMonth([
      line({ id: 'nodate', period_start: '' }),
      line({ id: 'dated', period_start: '2026-08-01' }),
    ]);
    expect(bands.map((b) => b.key)).toEqual(['2026-08', '']);
    expect(bands[1].label).toBe('Undated');
  });

  it('is empty for no rows', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});
