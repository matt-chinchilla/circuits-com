import { describe, expect, it } from 'vitest';
import {
  BULK_DELETE_MAX,
  chunkIds,
  confirmDeleteCopy,
  deleteOutcomeMessage,
  headerSelectionState,
  normalizeBulkResult,
  pruneSelection,
  selectRowLabel,
  selectionLabel,
  toggleAllVisible,
  toggleSelected,
  visibleSelectedIds,
} from './selection';

const set = (...ids: string[]) => new Set(ids);

describe('toggleSelected', () => {
  it('adds an unselected id and removes a selected one', () => {
    expect([...toggleSelected(set(), 'a')]).toEqual(['a']);
    expect([...toggleSelected(set('a', 'b'), 'a')]).toEqual(['b']);
  });

  it('never mutates the input set', () => {
    const before = set('a');
    toggleSelected(before, 'b');
    expect([...before]).toEqual(['a']);
  });
});

describe('visibleSelectedIds', () => {
  it('intersects the selection with what the filter is showing', () => {
    expect(visibleSelectedIds(set('a', 'c'), ['a', 'b'])).toEqual(['a']);
  });

  it('returns ids in visible order, not selection order', () => {
    expect(visibleSelectedIds(set('c', 'a'), ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
});

describe('pruneSelection', () => {
  it('drops ids that scrolled out of the filter', () => {
    expect([...pruneSelection(set('a', 'z'), ['a', 'b'])]).toEqual(['a']);
  });

  it('returns the SAME instance when nothing changed (no re-render loop)', () => {
    const before = set('a');
    expect(pruneSelection(before, ['a', 'b'])).toBe(before);
  });
});

describe('headerSelectionState', () => {
  it('is none on an empty list even if stale ids are selected', () => {
    expect(headerSelectionState(set('a'), [])).toBe('none');
  });

  it('reports none / some / all against the visible rows', () => {
    expect(headerSelectionState(set(), ['a', 'b'])).toBe('none');
    expect(headerSelectionState(set('a'), ['a', 'b'])).toBe('some');
    expect(headerSelectionState(set('a', 'b'), ['a', 'b'])).toBe('all');
  });

  it('ignores selected rows the filter is hiding', () => {
    expect(headerSelectionState(set('a', 'b', 'hidden'), ['a', 'b'])).toBe('all');
  });
});

describe('toggleAllVisible', () => {
  it('selects every visible row from empty', () => {
    expect([...toggleAllVisible(set(), ['a', 'b'])]).toEqual(['a', 'b']);
  });

  it('completes a partial selection rather than clearing it', () => {
    expect([...toggleAllVisible(set('a'), ['a', 'b'])]).toEqual(['a', 'b']);
  });

  it('clears when everything visible is already selected', () => {
    expect([...toggleAllVisible(set('a', 'b'), ['a', 'b'])]).toEqual([]);
  });

  it('leaves hidden selections untouched when clearing', () => {
    expect([...toggleAllVisible(set('a', 'hidden'), ['a'])]).toEqual(['hidden']);
  });
});

describe('chunkIds', () => {
  it('keeps a small selection in one request', () => {
    expect(chunkIds(['a', 'b'])).toEqual([['a', 'b']]);
  });

  it('splits past the server cap so a big selection cannot 422', () => {
    const ids = Array.from({ length: BULK_DELETE_MAX + 5 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(BULK_DELETE_MAX);
    expect(chunks[1]).toHaveLength(5);
    expect(chunks.flat()).toEqual(ids);
  });

  it('returns nothing for an empty selection', () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe('selectionLabel + selectRowLabel', () => {
  it('counts the selection', () => {
    expect(selectionLabel(1)).toBe('1 selected');
    expect(selectionLabel(12)).toBe('12 selected');
  });

  it('names the row by its printed designator', () => {
    expect(selectRowLabel(7)).toBe('Select message MSG-0007');
  });
});

describe('confirmDeleteCopy', () => {
  it('names the count and says it cannot be undone', () => {
    const one = confirmDeleteCopy(1);
    expect(one.title).toBe('Delete 1 message?');
    expect(one.message).toContain('cannot be undone');
    expect(one.confirmLabel).toBe('Delete message');

    const many = confirmDeleteCopy(4);
    expect(many.title).toBe('Delete 4 messages?');
    expect(many.message).toContain('4 messages');
    expect(many.message).toContain('cannot be undone');
    expect(many.confirmLabel).toBe('Delete 4 messages');
  });
});

describe('normalizeBulkResult', () => {
  it('defaults absent or junk counts to zero', () => {
    expect(normalizeBulkResult(undefined)).toEqual({ deleted: 0, missing: 0 });
    expect(normalizeBulkResult({ deleted: 'x' })).toEqual({ deleted: 0, missing: 0 });
    expect(normalizeBulkResult({ deleted: -3, missing: 2.7 })).toEqual({
      deleted: 0,
      missing: 2,
    });
  });

  it('passes real counts through', () => {
    expect(normalizeBulkResult({ deleted: 3, missing: 1 })).toEqual({
      deleted: 3,
      missing: 1,
    });
  });
});

describe('deleteOutcomeMessage', () => {
  it('reports a clean delete', () => {
    expect(deleteOutcomeMessage({ deleted: 1, missing: 0 })).toBe('Deleted 1 message');
    expect(deleteOutcomeMessage({ deleted: 3, missing: 0 })).toBe('Deleted 3 messages');
  });

  it('does NOT claim rows that were already gone', () => {
    expect(deleteOutcomeMessage({ deleted: 3, missing: 1 })).toBe(
      'Deleted 3 messages · 1 was already gone',
    );
    expect(deleteOutcomeMessage({ deleted: 3, missing: 2 })).toBe(
      'Deleted 3 messages · 2 were already gone',
    );
  });

  it('says so when nothing was there to delete', () => {
    expect(deleteOutcomeMessage({ deleted: 0, missing: 2 })).toBe(
      'Nothing deleted · 2 were already gone',
    );
  });
});
