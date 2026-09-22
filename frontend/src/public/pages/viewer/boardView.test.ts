import { describe, expect, it, vi } from 'vitest';
import type { LayerInfo } from '@public/components/kicad/canvasController';
import { layerKind, layerSide } from '@public/components/kicad/layerColors';
import {
  EMPTY_BOARD_VIEW,
  applyToCanvas,
  clearHighlights,
  drawnIn3D,
  groupLayers,
  groupVisibility,
  layersFromFile,
  netsFromFile,
  onSide,
  opacityOf,
  sameLayers,
  setAllLayers,
  setLayerVisible,
  setOpacity,
  toggleLayerHighlight,
  toggleNet,
  type BoardViewState,
  type CanvasBoardControls,
  type PanelLayer,
} from './boardView';

const BOARD = `(kicad_pcb (version 20221018)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user) (39 "F.Mask" user))
  (net 0 "")
  (net 1 "GND")
  (net 2 "/SDA")
)`;

function layer(name: string, over: Partial<LayerInfo> = {}): LayerInfo {
  return { name, kind: 'copper', side: 'F', color: 'rgba(0, 0, 0, 1)', visible: true, highlighted: false, ...over };
}

function fakeCanvas(layers: LayerInfo[]) {
  const canvas = {
    layers: vi.fn(() => layers),
    setLayerVisible: vi.fn(),
    highlightLayer: vi.fn(),
    setObjectOpacity: vi.fn(),
    highlightNet: vi.fn(),
  } satisfies CanvasBoardControls;
  return canvas;
}

describe('the reducers', () => {
  it('hides and shows a layer, returning the same state when nothing changes', () => {
    const hidden = setLayerVisible(EMPTY_BOARD_VIEW, 'F.Cu', false);
    expect([...hidden.hiddenLayers]).toEqual(['F.Cu']);
    expect(setLayerVisible(hidden, 'F.Cu', false)).toBe(hidden);
    expect(setLayerVisible(hidden, 'F.Cu', true).hiddenLayers.size).toBe(0);
    expect(EMPTY_BOARD_VIEW.hiddenLayers.size).toBe(0);
  });

  it('hiding the lit layer clears the highlight; lighting a hidden layer shows it', () => {
    const lit = toggleLayerHighlight(EMPTY_BOARD_VIEW, 'B.Cu');
    expect(lit.highlightedLayer).toBe('B.Cu');
    expect(setLayerVisible(lit, 'B.Cu', false).highlightedLayer).toBeNull();
    const hidden = setLayerVisible(EMPTY_BOARD_VIEW, 'B.Cu', false);
    const relit = toggleLayerHighlight(hidden, 'B.Cu');
    expect(relit.hiddenLayers.has('B.Cu')).toBe(false);
    expect(relit.highlightedLayer).toBe('B.Cu');
    // The same name again clears.
    expect(toggleLayerHighlight(relit, 'B.Cu').highlightedLayer).toBeNull();
  });

  it('hides all and shows all', () => {
    const all = setAllLayers(toggleLayerHighlight(EMPTY_BOARD_VIEW, 'F.Cu'), ['F.Cu', 'B.Cu'], false);
    expect([...all.hiddenLayers].sort()).toEqual(['B.Cu', 'F.Cu']);
    expect(all.highlightedLayer).toBeNull();
    expect(setAllLayers(all, ['F.Cu', 'B.Cu'], true).hiddenLayers.size).toBe(0);
  });

  it('stores only non-default opacity, clamped', () => {
    const faded = setOpacity(EMPTY_BOARD_VIEW, 'zones', 0.4);
    expect(faded.opacity).toEqual({ zones: 0.4 });
    expect(opacityOf(faded, 'tracks')).toBe(1);
    expect(setOpacity(faded, 'zones', 1).opacity).toEqual({});
    expect(setOpacity(EMPTY_BOARD_VIEW, 'grid', -3).opacity).toEqual({ grid: 0 });
    expect(setOpacity(faded, 'zones', 0.4)).toBe(faded);
  });

  it('a net toggles, and Esc clears either highlight first', () => {
    const lit = toggleNet(EMPTY_BOARD_VIEW, 5);
    expect(lit.highlightedNet).toBe(5);
    expect(toggleNet(lit, 5).highlightedNet).toBeNull();
    expect(toggleNet(lit, 6).highlightedNet).toBe(6);
    expect(clearHighlights(lit).highlightedNet).toBeNull();
    expect(clearHighlights(EMPTY_BOARD_VIEW)).toBe(EMPTY_BOARD_VIEW);
  });
});

describe('the lists read from the file', () => {
  it('lists the layers in the Board tab’s order and colours', () => {
    const layers = layersFromFile(BOARD);
    // KiCanvas's panel order: copper first (F, then B), silk, mask, then Edge.Cuts.
    expect(layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu', 'F.SilkS', 'F.Mask', 'Edge.Cuts']);
    expect(layers[0]).toEqual({ name: 'F.Cu', kind: 'copper', side: 'F', color: 'rgba(200, 52, 52, 1)' });
    expect(layers.find((l) => l.name === 'Edge.Cuts')?.side).toBeNull();
  });

  it('lists the nets without net 0, and answers [] for a board it cannot read', () => {
    expect(netsFromFile(BOARD)).toEqual([{ number: 1, name: 'GND' }, { number: 2, name: '/SDA' }]);
    expect(layersFromFile('not a board')).toEqual([]);
    expect(netsFromFile('(kicad_pcb (layers')).toEqual([]);
  });

  it('knows which layers the 3D view draws', () => {
    expect(['F.Cu', 'B.Cu', 'F.Mask', 'B.SilkS'].every(drawnIn3D)).toBe(true);
    expect(['In1.Cu', 'Edge.Cuts', 'F.Fab', 'F.Paste'].some(drawnIn3D)).toBe(false);
  });

  it('compares lists by name and colour only', () => {
    const a = [{ name: 'F.Cu', kind: 'copper' as const, side: 'F' as const, color: 'red' }];
    expect(sameLayers(a, [{ ...a[0] }])).toBe(true);
    expect(sameLayers(a, [{ ...a[0], color: 'blue' }])).toBe(false);
  });
});

describe('applyToCanvas', () => {
  it('does nothing and says so while no board is on screen', () => {
    const canvas = fakeCanvas([]);
    expect(applyToCanvas(canvas, null, setLayerVisible(EMPTY_BOARD_VIEW, 'F.Cu', false))).toBe(false);
    expect(canvas.setLayerVisible).not.toHaveBeenCalled();
    expect(canvas.highlightNet).not.toHaveBeenCalled();
  });

  it('on a fresh board sends only what differs from the defaults', () => {
    const canvas = fakeCanvas([layer('F.Cu'), layer('B.Cu')]);
    let state: BoardViewState = setLayerVisible(EMPTY_BOARD_VIEW, 'B.Cu', false);
    state = setOpacity(state, 'zones', 0.5);
    state = setOpacity(state, 'bodies', 0); // a 3D-only class: never sent to the 2D board
    expect(applyToCanvas(canvas, null, state)).toBe(true);
    expect(canvas.setLayerVisible.mock.calls).toEqual([['B.Cu', false]]);
    expect(canvas.highlightLayer).not.toHaveBeenCalled();
    expect(canvas.setObjectOpacity.mock.calls).toEqual([['zones', 0.5]]);
    expect(canvas.highlightNet).not.toHaveBeenCalled();
  });

  it('re-applied after the board’s own echo, sends nothing', () => {
    const state = toggleNet(setOpacity(setLayerVisible(EMPTY_BOARD_VIEW, 'B.Cu', false), 'tracks', 0.3), 4);
    const canvas = fakeCanvas([layer('F.Cu'), layer('B.Cu', { visible: false })]);
    applyToCanvas(canvas, state, state);
    expect(canvas.setLayerVisible).not.toHaveBeenCalled();
    expect(canvas.setObjectOpacity).not.toHaveBeenCalled();
    expect(canvas.highlightNet).not.toHaveBeenCalled();
  });

  it('restores a layer a reload made visible again, and lights only a layer the board has', () => {
    const state = toggleLayerHighlight(setLayerVisible(EMPTY_BOARD_VIEW, 'B.Cu', false), 'F.Cu');
    const canvas = fakeCanvas([layer('F.Cu'), layer('B.Cu')]);
    applyToCanvas(canvas, state, state);
    expect(canvas.setLayerVisible.mock.calls).toEqual([['B.Cu', false]]);
    expect(canvas.highlightLayer.mock.calls).toEqual([['F.Cu']]);
    const other = fakeCanvas([layer('F.Cu', { highlighted: true })]);
    applyToCanvas(other, state, toggleLayerHighlight(EMPTY_BOARD_VIEW, 'In9.Cu'));
    expect(other.highlightLayer.mock.calls).toEqual([[null]]);
  });

  it('puts an opacity back to full and clears a net', () => {
    const before = toggleNet(setOpacity(EMPTY_BOARD_VIEW, 'pads', 0.2), 3);
    const canvas = fakeCanvas([layer('F.Cu')]);
    applyToCanvas(canvas, before, EMPTY_BOARD_VIEW);
    expect(canvas.setObjectOpacity.mock.calls).toEqual([['pads', 1]]);
    expect(canvas.highlightNet.mock.calls).toEqual([[null]]);
  });
});

// The Layers tab's hierarchy: six groups in a fixed order, a side filter, a
// tri-state per group, and bulk actions scoped to what is listed.
describe('the layer hierarchy', () => {
  const row = (name: string): PanelLayer => ({ name, kind: layerKind(name), side: layerSide(name), color: 'x' });
  const GLASGOW = [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.Adhes', 'B.Adhes', 'F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS',
    'F.Mask', 'B.Mask', 'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Edge.Cuts', 'Margin',
    'F.CrtYd', 'B.CrtYd', 'F.Fab', 'B.Fab', 'User.1', 'Custom.Layer',
  ].map(row);

  it('files every layer under the owner’s six groups, in their order', () => {
    const groups = groupLayers(GLASGOW);
    expect(groups.map((g) => g.label)).toEqual(['Copper', 'Solder mask', 'Paste mask', 'Silkscreen', 'Mechanical', 'Other']);
    const names = Object.fromEntries(groups.map((g) => [g.id, g.layers.map((l) => l.name)]));
    expect(names.copper).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(names.mask).toEqual(['F.Mask', 'B.Mask']);
    expect(names.paste).toEqual(['F.Paste', 'B.Paste']);
    expect(names.silk).toEqual(['F.SilkS', 'B.SilkS']);
    // Edge, courtyards, fab, Margin and the four drawing/comment/Eco layers.
    expect(names.mechanical).toEqual(['Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Edge.Cuts', 'Margin', 'F.CrtYd', 'B.CrtYd', 'F.Fab', 'B.Fab']);
    // User.N and anything unmapped.
    expect(names.other).toEqual(['F.Adhes', 'B.Adhes', 'User.1', 'Custom.Layer']);
    // Every layer is listed exactly once.
    expect(groups.flatMap((g) => g.layers).length).toBe(GLASGOW.length);
  });

  it('leaves an empty group out', () => {
    expect(groupLayers([row('F.Cu'), row('Edge.Cuts')]).map((g) => g.id)).toEqual(['copper', 'mechanical']);
    expect(groupLayers([])).toEqual([]);
  });

  it('the side filter keeps board-wide layers on both faces and inner copper on neither', () => {
    const top = groupLayers(GLASGOW, 'top').flatMap((g) => g.layers.map((l) => l.name));
    expect(top).toContain('F.Cu');
    expect(top).toContain('Edge.Cuts');
    expect(top).toContain('Dwgs.User');
    expect(top).not.toContain('B.Cu');
    expect(top).not.toContain('In1.Cu');
    const bottom = groupLayers(GLASGOW, 'bottom').flatMap((g) => g.layers.map((l) => l.name));
    expect(bottom).toContain('B.Mask');
    expect(bottom).toContain('Margin');
    expect(bottom).not.toContain('F.Mask');
    expect(bottom).not.toContain('In2.Cu');
    expect(groupLayers(GLASGOW, 'both').flatMap((g) => g.layers).length).toBe(GLASGOW.length);
    expect(onSide({ side: 'In' }, 'top')).toBe(false);
    expect(onSide({ side: null }, 'bottom')).toBe(true);
  });

  it('answers all, some or none for a group', () => {
    const names = ['F.Cu', 'B.Cu'];
    expect(groupVisibility(EMPTY_BOARD_VIEW, names)).toBe('all');
    expect(groupVisibility(setLayerVisible(EMPTY_BOARD_VIEW, 'F.Cu', false), names)).toBe('some');
    expect(groupVisibility(setAllLayers(EMPTY_BOARD_VIEW, names, false), names)).toBe('none');
    expect(groupVisibility(EMPTY_BOARD_VIEW, [])).toBe('all');
  });

  it('"Show all" restores only the listed layers, so a filtered view never resurrects the other face', () => {
    const hidden = setAllLayers(EMPTY_BOARD_VIEW, ['F.Cu', 'B.Cu', 'F.Mask'], false);
    const shownTop = setAllLayers(hidden, ['F.Cu', 'F.Mask'], true);
    expect([...shownTop.hiddenLayers]).toEqual(['B.Cu']);
    // Nothing to show: the same state comes back.
    expect(setAllLayers(shownTop, ['F.Cu'], true)).toBe(shownTop);
    // Hiding a group that holds the lit layer clears the light; another
    // group's light survives.
    const lit = toggleLayerHighlight(EMPTY_BOARD_VIEW, 'F.Cu');
    expect(setAllLayers(lit, ['F.Cu', 'B.Cu'], false).highlightedLayer).toBeNull();
    expect(setAllLayers(lit, ['F.Mask'], false).highlightedLayer).toBe('F.Cu');
  });
});
