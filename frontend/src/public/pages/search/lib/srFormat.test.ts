import { describe, expect, it } from 'vitest';
import {
  displayWebsite,
  formatCount,
  formatLeadTime,
  formatPrice,
  formatRohs,
  srInitials,
  tierRank,
} from './srFormat';

describe('formatLeadTime', () => {
  it('renders whole weeks', () => {
    expect(formatLeadTime(7)).toBe('1w');
    expect(formatLeadTime(14)).toBe('2w');
    expect(formatLeadTime(42)).toBe('6w');
  });

  it('rounds partial weeks UP (28 days is 4w, 29 days is 5w)', () => {
    expect(formatLeadTime(28)).toBe('4w');
    expect(formatLeadTime(29)).toBe('5w');
    expect(formatLeadTime(1)).toBe('1w');
  });

  it('zero days is 0w (in stock), not unknown', () => {
    expect(formatLeadTime(0)).toBe('0w');
  });

  it('null AND undefined render the em dash (the ?:-misses-null trap)', () => {
    expect(formatLeadTime(null)).toBe('\u2014');
    expect(formatLeadTime(undefined)).toBe('\u2014');
  });
});

describe('formatPrice', () => {
  it('tiers precision like the category PartsTable', () => {
    expect(formatPrice(123.456)).toBe('$123');
    expect(formatPrice(12.5)).toBe('$12.50');
    expect(formatPrice(0.042)).toBe('$0.042');
  });

  it('null → em dash', () => {
    expect(formatPrice(null)).toBe('\u2014');
  });
});

describe('formatRohs', () => {
  it('check for compliant, "No" for non-compliant, em dash for unknown', () => {
    expect(formatRohs(true)).toBe('✓');
    expect(formatRohs(false)).toBe('No');
    expect(formatRohs(null)).toBe('—');
    expect(formatRohs(undefined)).toBe('—');
  });
});

describe('formatCount', () => {
  it('thousands-separates', () => {
    expect(formatCount(41203)).toBe('41,203');
    expect(formatCount(0)).toBe('0');
  });
});

describe('srInitials', () => {
  it('takes the first letters of up to two words', () => {
    expect(srInitials('Mouser Electronics')).toBe('ME');
    expect(srInitials('Digi-Key')).toBe('D');
    expect(srInitials('TE Connectivity / AMP')).toBe('TC');
  });
});

describe('displayWebsite', () => {
  it('strips scheme, www. and trailing slashes', () => {
    expect(displayWebsite('https://www.mouser.com/')).toBe('mouser.com');
    expect(displayWebsite('digikey.com')).toBe('digikey.com');
  });

  it('null/empty stays null (meta line renders the em dash itself)', () => {
    expect(displayWebsite(null)).toBeNull();
    expect(displayWebsite('   ')).toBeNull();
  });
});

describe('tierRank', () => {
  it('platinum > gold > silver > untiered', () => {
    expect(tierRank('platinum')).toBe(0);
    expect(tierRank('gold')).toBe(1);
    expect(tierRank('silver')).toBe(2);
    expect(tierRank(null)).toBe(3);
    expect(tierRank('anything-else')).toBe(3);
  });

  it('tolerates stray casing even though the server normalizes lowercase', () => {
    expect(tierRank('Platinum')).toBe(0);
  });
});
