import { describe, expect, it } from 'vitest';
import {
  dualPriceRows,
  money,
  percentLabel,
  priceRowText,
  priceRows,
  typeaheadMatch,
} from './priceRows';

const gold = {
  list: 2500,
  founder: 2100,
  floor: 1750,
  options: Array.from({ length: 16 }, (_, p) => ({
    code_points: p,
    price_usd: Math.max(1750, 2100 - Math.ceil((p * 2500) / 100)),
  })),
};
const platinum = {
  list: 10000,
  founder: 8500,
  floor: 7000,
  options: Array.from({ length: 16 }, (_, p) => ({
    code_points: p,
    price_usd: Math.max(7000, 8500 - Math.ceil((p * 10000) / 100)),
  })),
};

describe('money / percentLabel', () => {
  it('formats whole dollars with separators', () => {
    expect(money(8000)).toBe('$8,000');
    expect(money(175)).toBe('$175');
  });
  it('says the percent, never points; zero is the Founder’s Deal', () => {
    expect(percentLabel(1)).toBe('1%');
    expect(percentLabel(15)).toBe('15%');
    expect(percentLabel(0)).toBe('Founder’s Deal');
  });
});

describe('priceRows', () => {
  it('puts the dollars first and the percent second', () => {
    const rows = priceRows(platinum);
    const five = rows.find((r) => r.value === 5)!;
    expect(five.prices).toEqual([{ tier: null, usd: 8000 }]);
    expect(priceRowText(five)).toBe('$8,000 | 5%');
    expect(priceRowText(rows[0])).toBe('$8,500 | Founder’s Deal');
  });
  it('marks rows the 30% floor caps, and the current row', () => {
    const rows = priceRows(gold, { current: 10 });
    expect(rows.find((r) => r.value === 13)!.capped).toBe(false); // 2100 - 325 = 1775
    expect(rows.find((r) => r.value === 14)!.capped).toBe(true); // 1750 = floor
    expect(rows.find((r) => r.value === 15)!.capped).toBe(true);
    expect(rows.filter((r) => r.current).map((r) => r.value)).toEqual([10]);
  });
  it('can leave out the Founder’s Deal row (a code is always 1–15%)', () => {
    expect(priceRows(gold, { includeFounder: false }).map((r) => r.value)[0]).toBe(1);
  });
});

describe('dualPriceRows', () => {
  it('shows both tiers’ prices, gold first, then the percent', () => {
    const row = dualPriceRows({ gold, platinum }, [10])[0];
    expect(row.prices).toEqual([
      { tier: 'gold', usd: 1850 },
      { tier: 'platinum', usd: 7500 },
    ]);
    expect(priceRowText(row)).toBe('Gold $1,850 · Platinum $7,500 | 10%');
  });
  it('falls back to the percent alone while the ladder loads', () => {
    const row = dualPriceRows({}, [3])[0];
    expect(row.prices).toEqual([]);
    expect(priceRowText(row)).toBe('3%');
  });
});

describe('typeaheadMatch', () => {
  const rows = priceRows(gold);
  const opts = rows.map((r) => ({ value: r.value, label: priceRowText(r), keys: [String(r.value)] }));
  it('jumps to a percent by typing its digits', () => {
    expect(typeaheadMatch('5', opts)).toBe(5);
    expect(typeaheadMatch('12', opts)).toBe(12);
  });
  it('falls back to a case-insensitive label prefix', () => {
    const text = [
      { value: 'a', label: 'Anthony' },
      { value: 'd', label: 'Daniel' },
    ];
    expect(typeaheadMatch('da', text)).toBe(1);
    expect(typeaheadMatch('zz', text)).toBe(-1);
  });
});
