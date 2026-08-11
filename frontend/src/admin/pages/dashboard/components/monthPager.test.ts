import { describe, expect, it } from 'vitest';
import { monthPagerState, pagerMonthLabel } from './monthPager';

// The contract's own shape: desc, distinct, only months that hold rows.
const MONTHS = ['2026-08', '2026-07', '2026-05', '2025-12'];

describe('monthPagerState', () => {
  it('steps through the LIST, not the calendar — June is skipped', () => {
    // 2026-06 holds no expense rows, so it is not a destination.
    expect(monthPagerState(MONTHS, '2026-07').older).toBe('2026-05');
    expect(monthPagerState(MONTHS, '2026-05').newer).toBe('2026-07');
  });

  it('crosses a year boundary', () => {
    expect(monthPagerState(MONTHS, '2026-05').older).toBe('2025-12');
    expect(monthPagerState(MONTHS, '2025-12').newer).toBe('2026-05');
  });

  it('caps at both ends', () => {
    expect(monthPagerState(MONTHS, '2026-08').newer).toBeNull();
    expect(monthPagerState(MONTHS, '2025-12').older).toBeNull();
  });

  it('still pages when the served month has NO rows of its own', () => {
    // The endpoint serves the current month whether or not it holds rows;
    // `available_months` only lists months that do. An index lookup would
    // return -1 here and dead-end both arrows.
    const state = monthPagerState(MONTHS, '2026-09');
    expect(state.older).toBe('2026-08');
    expect(state.newer).toBeNull();
    expect(state.visible).toBe(true);
  });

  it('does not assume the list arrives sorted', () => {
    const scrambled = ['2026-05', '2026-08', '2025-12', '2026-07'];
    expect(monthPagerState(scrambled, '2026-07')).toEqual({
      older: '2026-05',
      newer: '2026-08',
      visible: true,
    });
  });

  it('hides with one month or none — nothing to step to', () => {
    expect(monthPagerState(['2026-08'], '2026-08').visible).toBe(false);
    expect(monthPagerState([], '2026-08').visible).toBe(false);
    // Absent `available_months` (a pre-pager or demo payload).
    expect(monthPagerState(undefined, '2026-08').visible).toBe(false);
    // No served month yet (the page is still loading).
    expect(monthPagerState(MONTHS, null).visible).toBe(false);
  });
});

describe('pagerMonthLabel', () => {
  it('names the year, so a cross-year step is unambiguous', () => {
    expect(pagerMonthLabel('2026-08')).toBe('August 2026');
    expect(pagerMonthLabel('2025-12')).toBe('December 2025');
  });

  it('is UTC-anchored — never renders the previous month west of Greenwich', () => {
    expect(pagerMonthLabel('2026-01')).toBe('January 2026');
  });

  it('falls back to the raw key rather than printing Invalid Date', () => {
    expect(pagerMonthLabel('')).toBe('');
    expect(pagerMonthLabel('nonsense')).toBe('nonsense');
  });
});
