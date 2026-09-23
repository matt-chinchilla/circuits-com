import { describe, expect, it } from 'vitest';
import { VIEWER_MODE_KEY, isViewerMode, readMode, writeMode, type ModeStorage } from './viewerMode';

function memory(initial: Record<string, string> = {}): ModeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('the viewer mode', () => {
  it('follows the system when nothing is stored, and the stored choice after that', () => {
    expect(readMode(memory(), false)).toBe('day');
    expect(readMode(memory(), true)).toBe('night');
    const store = memory();
    writeMode('night', store);
    expect(store.data[VIEWER_MODE_KEY]).toBe('night');
    expect(readMode(store, false)).toBe('night');
    writeMode('day', store);
    expect(readMode(store, true)).toBe('day');
  });

  it('with nothing to read from at all — no storage, no window — it is day', () => {
    // A node test: `localStorage` and `window` are undefined here, so the
    // defaults resolve to no storage and no system preference.
    expect(readMode()).toBe('day');
  });

  it('treats a stored value it does not recognise as the default', () => {
    expect(readMode(memory({ [VIEWER_MODE_KEY]: 'dusk' }), false)).toBe('day');
    expect(readMode(memory({ [VIEWER_MODE_KEY]: '' }), true)).toBe('night');
  });

  it('survives a storage that throws, and no storage at all', () => {
    const hostile: ModeStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readMode(hostile, true)).toBe('night');
    expect(() => writeMode('day', hostile)).not.toThrow();
    expect(readMode(null, false)).toBe('day');
    expect(() => writeMode('night', null)).not.toThrow();
    expect(isViewerMode('night')).toBe(true);
    expect(isViewerMode('dark')).toBe(false);
  });
});
