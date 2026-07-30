import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_META,
  expenseCategoryLabel,
  expenseCategoryMeta,
  isExpenseCategory,
} from './expenseCategories';

describe('expense categories', () => {
  it('covers every category the backend Literal accepts', () => {
    // Mirrors app/schemas/expense.ExpenseCategory — adding one server-side
    // without a meta row here would render a blank glyph in the admin table.
    expect([...EXPENSE_CATEGORIES].sort()).toEqual([
      'ai',
      'domain',
      'email',
      'infrastructure',
      'other',
      'payment',
    ]);
    for (const c of EXPENSE_CATEGORIES) {
      expect(EXPENSE_CATEGORY_META[c].label).toBeTruthy();
      // Phosphor names must survive Icon.tsx's `/^[a-z][a-z0-9-]*$/` guard, or
      // the glyph silently renders as literal text.
      expect(EXPENSE_CATEGORY_META[c].icon).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('flags infrastructure as an estimate and nothing else', () => {
    const estimated = EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_META[c].estimated);
    expect(estimated).toEqual(['infrastructure']);
  });

  it('narrows only known values', () => {
    expect(isExpenseCategory('ai')).toBe(true);
    expect(isExpenseCategory('AI')).toBe(false);
    expect(isExpenseCategory(null)).toBe(false);
  });

  it('falls back to `other` meta for an unknown stored value', () => {
    expect(expenseCategoryMeta('legal')).toBe(EXPENSE_CATEGORY_META.other);
    expect(expenseCategoryMeta(null)).toBe(EXPENSE_CATEGORY_META.other);
  });

  it('title-cases an unrecognized label, mirroring the server helper', () => {
    expect(expenseCategoryLabel('  Infrastructure ')).toBe('Infrastructure');
    expect(expenseCategoryLabel('legal_fees')).toBe('Legal Fees');
    expect(expenseCategoryLabel('')).toBe('Other');
  });
});
