import { describe, expect, it } from 'vitest';
import { chargedMonthly } from './checkoutPrice';

describe('chargedMonthly', () => {
  it('renders the charged price when the server sends one', () => {
    expect(chargedMonthly({ monthly_total: 250, price_usd: 210 })).toBe(210);
  });

  it('falls back to the list price only for an old API response', () => {
    expect(chargedMonthly({ monthly_total: 250 })).toBe(250);
    expect(chargedMonthly({ monthly_total: 250, price_usd: null })).toBe(250);
  });

  it('never invents a number', () => {
    expect(chargedMonthly(null)).toBeNull();
    expect(chargedMonthly({ monthly_total: undefined as unknown as number })).toBeNull();
  });
});
