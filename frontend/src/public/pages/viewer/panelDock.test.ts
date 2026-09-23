import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCK, PANEL_DOCK_KEY, isPanelTab, readDock, writeDock, type DockStorage } from './panelDock';

function memory(initial: Record<string, string> = {}): DockStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('the panel dock', () => {
  it('opens on Parts by default, and round-trips what was written', () => {
    const store = memory();
    expect(readDock(store)).toEqual(DEFAULT_DOCK);
    writeDock({ tab: 'layers', docked: false }, store);
    expect(JSON.parse(store.data[PANEL_DOCK_KEY]!)).toEqual({ tab: 'layers', docked: false });
    expect(readDock(store)).toEqual({ tab: 'layers', docked: false });
  });

  it('treats a stored value it does not recognise as the default', () => {
    for (const raw of ['not json', '[]', 'null', '{"tab":"nets","docked":true}', '{"tab":"parts","docked":"yes"}', '{"docked":true}']) {
      expect(readDock(memory({ [PANEL_DOCK_KEY]: raw })), raw).toEqual(DEFAULT_DOCK);
    }
  });

  it('survives a storage that throws, on read and on write', () => {
    const hostile: DockStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readDock(hostile)).toEqual(DEFAULT_DOCK);
    expect(() => writeDock({ tab: 'objects', docked: true }, hostile)).not.toThrow();
    // …and with no storage at all.
    expect(readDock(null)).toEqual(DEFAULT_DOCK);
    expect(() => writeDock(DEFAULT_DOCK, null)).not.toThrow();
  });

  it('knows its own tabs', () => {
    expect(['sheets', 'parts', 'layers', 'objects'].every(isPanelTab)).toBe(true);
    expect(isPanelTab('nets')).toBe(false);
    expect(isPanelTab(1)).toBe(false);
  });
});
