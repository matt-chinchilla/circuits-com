import { describe, expect, it } from 'vitest';
import type { AccountSponsorship } from '@admin/types/account';
import {
  formatDate,
  formatMonthly,
  monthlyAmount,
  placementLabel,
  statusTone,
} from './customerSponsorship';

function row(over: Partial<AccountSponsorship> = {}): AccountSponsorship {
  return {
    id: 's1',
    tier: 'gold',
    placement: 'Bluetooth',
    placement_type: 'category',
    status: 'Active',
    is_active: true,
    amount: 2500,
    start_date: '2026-08-01',
    end_date: null,
    description: null,
    ...over,
  };
}

describe('monthlyAmount', () => {
  it('coerces the NUMERIC column however it arrives', () => {
    // The admin list meets this same column as a JSON string ("2500.00").
    expect(monthlyAmount(2500)).toBe(2500);
    expect(monthlyAmount('2500.00' as unknown as number)).toBe(2500);
  });

  it('is null for no amount and for anything non-numeric', () => {
    expect(monthlyAmount(null)).toBeNull();
    expect(monthlyAmount('n/a' as unknown as number)).toBeNull();
  });
});

describe('formatMonthly', () => {
  it('prints whole dollars for the tier prices, cents only when there are any', () => {
    expect(formatMonthly(2500)).toBe('$2,500');
    expect(formatMonthly(250)).toBe('$250');
    expect(formatMonthly(99.5)).toBe('$99.50');
  });

  it('prints a dash rather than $0 when no amount was recorded', () => {
    expect(formatMonthly(null)).toBe('\u2014');
  });
});

describe('formatDate', () => {
  it('dashes an open-ended window', () => {
    expect(formatDate('2026-08-01')).toBe('2026-08-01');
    expect(formatDate(null)).toBe('\u2014');
  });
});

describe('statusTone', () => {
  it('trusts is_active, which has already read NULL status as Active', () => {
    // The legacy seed omits status entirely; the server defaults it, and a
    // client-side string check could only disagree with that.
    expect(statusTone(row({ status: 'Active', is_active: true }))).toBe('active');
    expect(statusTone(row({ status: 'Paused', is_active: false }))).toBe('paused');
    expect(statusTone(row({ status: 'Expired', is_active: false }))).toBe('expired');
  });

  it('has a tone for a status nobody has written yet', () => {
    expect(statusTone(row({ status: 'Pending', is_active: false }))).toBe('unknown');
  });
});

describe('placementLabel', () => {
  it('names a category placement by its category', () => {
    expect(placementLabel(row({ placement: 'Bluetooth', placement_type: 'category' }))).toBe(
      'Bluetooth',
    );
  });

  it('marks a keyword placement as one', () => {
    expect(placementLabel(row({ placement: 'mosfet', placement_type: 'keyword' }))).toBe(
      'keyword: mosfet',
    );
  });

  it('dashes a row that carries neither side of the XOR', () => {
    // The XOR is a Postgres CHECK that SQLite skips, so the route sends null
    // rather than guessing — and so does this.
    expect(placementLabel(row({ placement: null, placement_type: null }))).toBe('\u2014');
  });
});
