import { describe, expect, it } from 'vitest';
import {
  dailyPoints,
  isFlat,
  referralPoints,
  revenuePoints,
  shortMonthLabel,
} from './series';

describe('shortMonthLabel', () => {
  it('abbreviates a month', () => {
    expect(shortMonthLabel('2026-08')).toBe('Aug');
  });

  it('carries the year on January, where the boundary is', () => {
    expect(shortMonthLabel('2026-01')).toBe("Jan '26");
  });

  it('does not slide west of Greenwich', () => {
    // `new Date('2026-08')` is midnight UTC rendered locally, which prints
    // July for anyone with a negative offset. Field-by-field parsing cannot.
    expect(shortMonthLabel('2026-03')).toBe('Mar');
    expect(shortMonthLabel('2026-12')).toBe('Dec');
  });

  it('falls back to the raw key rather than an empty label', () => {
    expect(shortMonthLabel('')).toBe('');
    expect(shortMonthLabel('nonsense')).toBe('nonsense');
    expect(shortMonthLabel('2026-13')).toBe('2026-13');
  });
});

describe('referralPoints / revenuePoints', () => {
  it('keeps the payload order — oldest first, left to right', () => {
    const points = referralPoints([
      { month: '2026-07', clicks: 4 },
      { month: '2026-08', clicks: 9 },
    ]);
    expect(points).toEqual([
      { label: 'Jul', value: 4 },
      { label: 'Aug', value: 9 },
    ]);
  });

  it('reads money as a number', () => {
    expect(revenuePoints([{ month: '2026-08', amount: 1250.5 }])).toEqual([
      { label: 'Aug', value: 1250.5 },
    ]);
  });

  it('renders a non-finite value as zero, never NaN', () => {
    expect(revenuePoints([{ month: '2026-08', amount: Number.NaN }])[0].value).toBe(0);
  });
});

describe('dailyPoints', () => {
  it('maps onto the shared sparkline point shape', () => {
    expect(dailyPoints([{ date: '2026-08-27', clicks: 3 }])).toEqual([
      { day: '2026-08-27', value: 3 },
    ]);
  });
});

describe('isFlat', () => {
  it('is true for an all-zero series and for no series at all', () => {
    expect(isFlat([])).toBe(true);
    expect(isFlat([{ label: 'Aug', value: 0 }])).toBe(true);
  });

  it('is false as soon as anything happened', () => {
    expect(isFlat([{ label: 'Aug', value: 0 }, { label: 'Sep', value: 1 }])).toBe(false);
  });
});
