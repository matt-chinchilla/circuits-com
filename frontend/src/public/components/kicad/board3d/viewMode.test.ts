// @vitest-environment happy-dom
// The view-mode store: one value, two controls, remembered across visits.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW_MODE, VIEW_MODE_STORAGE_KEY, VIEW_MODES, getViewMode, isViewMode, resetViewModeForTests,
  setViewMode, subscribeViewMode, useViewMode, viewModeOption,
} from './viewMode';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.clear();
  resetViewModeForTests();
});
afterEach(() => {
  resetViewModeForTests();
});

describe('the view mode store', () => {
  it('offers exactly Solid, See-through and X-ray, each with a help line', () => {
    expect(VIEW_MODES.map((m) => m.id)).toEqual(['solid', 'see-through', 'xray']);
    expect(VIEW_MODES.map((m) => m.label)).toEqual(['Solid', 'See-through', 'X-ray']);
    for (const m of VIEW_MODES) expect(m.help.length).toBeGreaterThan(10);
    expect(viewModeOption('xray').label).toBe('X-ray');
  });
  it('starts solid and remembers a change in localStorage', () => {
    expect(getViewMode()).toBe(DEFAULT_VIEW_MODE);
    setViewMode('xray');
    expect(getViewMode()).toBe('xray');
    expect(localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('xray');
    resetViewModeForTests();
    expect(getViewMode()).toBe('xray');
  });
  it('ignores a value storage holds that is not a mode, and one a caller invents', () => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'wireframe');
    expect(getViewMode()).toBe('solid');
    setViewMode('glass' as never);
    expect(getViewMode()).toBe('solid');
    expect(isViewMode('see-through')).toBe(true);
    expect(isViewMode(null)).toBe(false);
  });
  it('tells subscribers once per real change, never for the same value again', () => {
    let calls = 0;
    const off = subscribeViewMode(() => { calls++; });
    setViewMode('see-through');
    setViewMode('see-through');
    expect(calls).toBe(1);
    off();
    setViewMode('solid');
    expect(calls).toBe(1);
  });
  it('survives a storage that throws', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('quota'); };
    try {
      expect(() => setViewMode('xray')).not.toThrow();
      expect(getViewMode()).toBe('xray');
    } finally {
      Storage.prototype.setItem = real;
    }
  });
  it('useViewMode re-renders a control when another control changes the mode', async () => {
    const seen: string[] = [];
    function Probe() { const mode = useViewMode(); seen.push(mode); return createElement('span', null, mode); }
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => { root.render(createElement(Probe)); });
    expect(el.textContent).toBe('solid');
    await act(async () => { setViewMode('xray'); });
    expect(el.textContent).toBe('xray');
    act(() => root.unmount());
  });
});
