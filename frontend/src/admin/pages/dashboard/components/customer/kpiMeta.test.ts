import { describe, expect, it } from 'vitest';
import type { AccountKpi } from '@admin/types/account';
import {
  humanizeKpiKey,
  isMoneyKpi,
  kpiAxisFormat,
  kpiChoices,
  kpiLabel,
  kpiValueFormat,
} from './kpiMeta';

const KPI: AccountKpi = {
  selected: 'parts_by_category',
  available: [
    { key: 'parts_by_category', label: 'Parts by category' },
    { key: 'stock_by_category', label: 'Stock by category' },
  ],
  points: [],
};

describe('isMoneyKpi', () => {
  it('is dollars for inventory value and a COUNT for stock', () => {
    // The two keys differ by one word and by orders of magnitude — printing
    // 41,271 stock units as currency is the failure this pins.
    expect(isMoneyKpi('inventory_value_by_category')).toBe(true);
    expect(isMoneyKpi('stock_by_category')).toBe(false);
    expect(isMoneyKpi('parts_by_category')).toBe(false);
  });

  it('reads an unknown key as a count, never as money', () => {
    expect(isMoneyKpi('some_future_kpi')).toBe(false);
  });
});

describe('kpiValueFormat / kpiAxisFormat', () => {
  it('formats money as currency and counts with separators', () => {
    expect(kpiValueFormat('inventory_value_by_category')(41271)).toBe('$41,271.00');
    expect(kpiValueFormat('stock_by_category')(41271)).toBe('41,271');
  });

  it('compacts the axis for money only', () => {
    expect(kpiAxisFormat('inventory_value_by_category')(41271)).toBe('$41K');
    expect(kpiAxisFormat('stock_by_category')(41271)).toBe('41,271');
  });
});

describe('humanizeKpiKey', () => {
  it('reads as a sentence, not a column name', () => {
    expect(humanizeKpiKey('inventory_value_by_category')).toBe('Inventory value by category');
    expect(humanizeKpiKey('distributors_by_parts')).toBe('Distributors by parts');
  });

  it('survives an empty key', () => {
    expect(humanizeKpiKey('')).toBe('');
  });
});

describe('kpiChoices', () => {
  it('offers exactly what the server allows', () => {
    expect(kpiChoices(KPI).map((c) => c.key)).toEqual([
      'parts_by_category',
      'stock_by_category',
    ]);
    expect(kpiChoices(KPI).every((c) => c.pickable)).toBe(true);
  });

  it('carries a stored key the account can no longer pick', () => {
    // Staff unlinked the supplier row while the stored pick was a
    // distributor-only KPI. Dropping it would make the select display the
    // WRONG label — the browser falls back to its first option.
    const stale: AccountKpi = { ...KPI, selected: 'manufacturers_by_parts' };
    const choices = kpiChoices(stale);
    expect(choices[0]).toEqual({
      key: 'manufacturers_by_parts',
      label: 'Manufacturers by parts',
      pickable: false,
    });
    expect(choices).toHaveLength(3);
  });

  it('does not duplicate the selected key', () => {
    expect(kpiChoices(KPI)).toHaveLength(2);
  });

  it('is empty for an unlinked account with nothing selected', () => {
    expect(kpiChoices({ selected: '', available: [], points: [] })).toEqual([]);
  });
});

describe('kpiLabel', () => {
  it('prefers the server label', () => {
    expect(kpiLabel(KPI)).toBe('Parts by category');
  });

  it('falls back to the humanized key', () => {
    expect(kpiLabel({ ...KPI, selected: 'manufacturers_by_parts' })).toBe(
      'Manufacturers by parts',
    );
  });
});
