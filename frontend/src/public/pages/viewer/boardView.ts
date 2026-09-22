// The Board panel's state (spec 2026-09-22 §2.4): ONE record on the viewer page
// that says which layers are hidden, which layer or net is lit, and how opaque
// each object class is. The Board (2D) tab and the 3D tab both draw from it, so
// a layer hidden on one is hidden on the other and survives every tab switch.
//
// Pure: the reducers the panel calls, the layer list it shows before a drawing
// has loaded, and `applyToCanvas`, which tells the 2D board what differs from
// what it already has. The 3D half is `applyBoardView` in Board3DView, which
// the page reaches through that component's props.
import type { LayerInfo, LayerKind, NetInfo, ObjectClass2D } from '@public/components/kicad/canvasController';
import { BOARD_LAYER_COLORS, FALLBACK_LAYER_COLOR, layerColor, layerKind, layerSide } from '@public/components/kicad/layerColors';
import type { ObjectClass3D } from '@public/components/kicad/board3d/sceneRenderer';
import { readLayerTable, readNetTable } from '@public/services/kicad/board3d/layerTable';

export type ObjectClass = ObjectClass2D | ObjectClass3D;

export interface BoardViewState {
  /** By layer name. */
  hiddenLayers: ReadonlySet<string>;
  highlightedLayer: string | null;
  /** 0..1 per class; absent = 1. 0 hides the class. */
  opacity: Partial<Record<ObjectClass, number>>;
  highlightedNet: number | null;
}

export const EMPTY_BOARD_VIEW: BoardViewState = Object.freeze({
  hiddenLayers: new Set<string>(),
  highlightedLayer: null,
  opacity: {},
  highlightedNet: null,
});

/** One row of the Layers tab: what the list needs, whichever source it came from. */
export interface PanelLayer {
  name: string;
  kind: LayerKind;
  side: LayerInfo['side'];
  color: string;
}

/** An object class as the Objects tab lists it. */
export interface ClassRow<K extends ObjectClass> {
  kind: K;
  label: string;
}

/** The 2D board's classes — the accessors KiCanvas has — in the order it lists them. */
export const CLASSES_2D: readonly ClassRow<ObjectClass2D>[] = [
  { kind: 'tracks', label: 'Tracks' },
  { kind: 'vias', label: 'Vias' },
  { kind: 'pads', label: 'Pads' },
  { kind: 'holes', label: 'Through-holes' },
  { kind: 'zones', label: 'Zones' },
  { kind: 'grid', label: 'Grid' },
  { kind: 'page', label: 'Page' },
];

/** The 3D board's classes. Vias are the drilled hole walls. */
export const CLASSES_3D: readonly ClassRow<ObjectClass3D>[] = [
  { kind: 'tracks', label: 'Tracks' },
  { kind: 'vias', label: 'Vias' },
  { kind: 'pads', label: 'Pads' },
  { kind: 'zones', label: 'Zones' },
  { kind: 'silk', label: 'Silkscreen' },
  { kind: 'mask', label: 'Mask' },
  { kind: 'bodies', label: 'Bodies' },
];

/**
 * Does the 3D view draw this layer? It draws the outer copper, the mask and
 * the silkscreen of each side (buildScene); inner copper and every technical
 * layer are not drawn in v1, so on the 3D tab those rows cannot be toggled.
 */
export function drawnIn3D(name: string): boolean {
  return /^[FB]\.(Cu|Mask|SilkS)$/.test(name);
}

export function opacityOf(state: BoardViewState, kind: ObjectClass): number {
  const o = state.opacity[kind];
  return o == null || !Number.isFinite(o) ? 1 : Math.min(1, Math.max(0, o));
}

// ─── Reducers ─────────────────────────────────────────────────────────────

export function setLayerVisible(state: BoardViewState, name: string, visible: boolean): BoardViewState {
  if (state.hiddenLayers.has(name) === !visible) return state;
  const hidden = new Set(state.hiddenLayers);
  if (visible) hidden.delete(name);
  else hidden.add(name);
  // A hidden layer cannot stay lit: the highlight would dim everything else
  // around a layer nobody can see.
  const highlightedLayer = !visible && state.highlightedLayer === name ? null : state.highlightedLayer;
  return { ...state, hiddenLayers: hidden, highlightedLayer };
}

/**
 * Show or hide every layer in `names` — the ones the panel is LISTING, which
 * the side filter may have narrowed — and no other. "Show all" on the Top
 * filter must not resurrect a bottom layer the reader hid on purpose. A lit
 * layer that gets hidden stops being lit, as in `setLayerVisible`.
 */
export function setAllLayers(state: BoardViewState, names: readonly string[], visible: boolean): BoardViewState {
  if (visible) {
    if (!names.some((n) => state.hiddenLayers.has(n))) return state;
    const hidden = new Set(state.hiddenLayers);
    for (const n of names) hidden.delete(n);
    return { ...state, hiddenLayers: hidden };
  }
  if (names.every((n) => state.hiddenLayers.has(n))) return state;
  const highlightedLayer = state.highlightedLayer != null && names.includes(state.highlightedLayer) ? null : state.highlightedLayer;
  return { ...state, hiddenLayers: new Set([...state.hiddenLayers, ...names]), highlightedLayer };
}

/** Light `name`; the same name again clears. Lighting a hidden layer shows it. */
export function toggleLayerHighlight(state: BoardViewState, name: string): BoardViewState {
  if (state.highlightedLayer === name) return { ...state, highlightedLayer: null };
  const next = state.hiddenLayers.has(name) ? setLayerVisible(state, name, true) : state;
  return { ...next, highlightedLayer: name };
}

export function setOpacity(state: BoardViewState, kind: ObjectClass, opacity: number): BoardViewState {
  const value = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  if (opacityOf(state, kind) === value) return state;
  const next = { ...state.opacity };
  if (value === 1) delete next[kind];
  else next[kind] = value;
  return { ...state, opacity: next };
}

/** Light `net`; the same net again clears. */
export function toggleNet(state: BoardViewState, net: number): BoardViewState {
  return { ...state, highlightedNet: state.highlightedNet === net ? null : net };
}

/** Esc's first job: clear any lit layer or net. Returns the SAME state when there was nothing to clear. */
export function clearHighlights(state: BoardViewState): BoardViewState {
  if (state.highlightedLayer == null && state.highlightedNet == null) return state;
  return { ...state, highlightedLayer: null, highlightedNet: null };
}

// ─── The Layers tab's hierarchy ───────────────────────────────────────────
// Layers are listed as a tree (owner, 2026-09-22: "group the content into
// layers, like a directory-hierarchy"): six groups in a fixed order, each a
// collapsible row with a tri-state box, the layers under it.

export type LayerGroupId = 'copper' | 'mask' | 'paste' | 'silk' | 'mechanical' | 'other';

export const LAYER_GROUPS: readonly { id: LayerGroupId; label: string }[] = [
  { id: 'copper', label: 'Copper' },
  { id: 'mask', label: 'Solder mask' },
  { id: 'paste', label: 'Paste mask' },
  { id: 'silk', label: 'Silkscreen' },
  { id: 'mechanical', label: 'Mechanical' },
  { id: 'other', label: 'Other' },
];

/**
 * Which group a layer files under. Mechanical is the board's own geometry and
 * its fabrication notes: Edge.Cuts, the courtyards, the fab layers, Margin,
 * and KiCad's four drawing/comment/Eco layers (`*.User`). The numbered
 * `User.N` layers and anything the palette does not know (F.Adhes, a custom
 * name) go under Other.
 */
export function layerGroup(layer: Pick<PanelLayer, 'name' | 'kind'>): LayerGroupId {
  switch (layer.kind) {
    case 'copper':
    case 'mask':
    case 'paste':
    case 'silk':
      return layer.kind;
    case 'edge':
    case 'courtyard':
    case 'fab':
      return 'mechanical';
    case 'user':
      return /\.User$/.test(layer.name) ? 'mechanical' : 'other';
    default:
      return layer.name === 'Margin' ? 'mechanical' : 'other';
  }
}

/** The Top / Bottom / Both filter at the top of the tab. */
export type SideFilter = 'top' | 'bottom' | 'both';

/** Is this layer listed under `side`? Board-wide layers (Edge.Cuts, Margin,
 *  the user layers — `side: null`) belong to every view; inner copper to
 *  neither face, so only to Both. */
export function onSide(layer: Pick<PanelLayer, 'side'>, side: SideFilter): boolean {
  if (side === 'both' || layer.side == null) return true;
  return layer.side === (side === 'top' ? 'F' : 'B');
}

export interface LayerGroup {
  id: LayerGroupId;
  label: string;
  layers: PanelLayer[];
}

/** The tab's tree: the groups in their fixed order, each with the listed
 *  layers in the order they arrived, empty groups left out. */
export function groupLayers(layers: readonly PanelLayer[], side: SideFilter = 'both'): LayerGroup[] {
  const by = new Map<LayerGroupId, PanelLayer[]>();
  for (const layer of layers) {
    if (!onSide(layer, side)) continue;
    const id = layerGroup(layer);
    const list = by.get(id);
    if (list == null) by.set(id, [layer]);
    else list.push(layer);
  }
  return LAYER_GROUPS.flatMap(({ id, label }) => {
    const grouped = by.get(id);
    return grouped == null ? [] : [{ id, label, layers: grouped }];
  });
}

export type GroupVisibility = 'all' | 'some' | 'none';

/** The group row's tri-state: are all, some or none of `names` shown? */
export function groupVisibility(state: BoardViewState, names: readonly string[]): GroupVisibility {
  let shown = 0;
  for (const n of names) if (!state.hiddenLayers.has(n)) shown += 1;
  if (shown === 0) return names.length === 0 ? 'all' : 'none';
  return shown === names.length ? 'all' : 'some';
}

// ─── The lists before any drawing has loaded ──────────────────────────────

const UI_ORDER = new Map(Object.keys(BOARD_LAYER_COLORS).map((name, i) => [name, i]));

/**
 * The board's layers from the file's own `(layers …)` table, in the order the
 * Board tab lists them (KiCanvas's layer-panel order, which is the key order
 * of `BOARD_LAYER_COLORS`), in the colours it draws them. What the panel shows
 * on the 3D tab and before the Board tab has loaded. An unreadable board
 * answers [] rather than throwing out of a render.
 */
export function layersFromFile(boardText: string): PanelLayer[] {
  let table;
  try {
    table = readLayerTable(boardText);
  } catch {
    return [];
  }
  const rank = (name: string) => UI_ORDER.get(name) ?? Number.MAX_SAFE_INTEGER;
  return table
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l.name) - rank(b.l.name) || a.i - b.i)
    .map(({ l }) => ({
      name: l.name,
      kind: layerKind(l.name),
      side: layerSide(l.name),
      color: layerColor(l.name) ?? FALLBACK_LAYER_COLOR,
    }));
}

/** The board's nets from the file's table, net 0 left out; [] for an unreadable board. */
export function netsFromFile(boardText: string): NetInfo[] {
  try {
    return readNetTable(boardText);
  } catch {
    return [];
  }
}

/** The renderer's layer list as panel rows. */
export function panelLayers(layers: readonly LayerInfo[]): PanelLayer[] {
  return layers.map(({ name, kind, side, color }) => ({ name, kind, side, color }));
}

/** Same rows, same order, same colours? A `layers` event that changed only a
 *  visibility flag must not re-render the panel's list. */
export function sameLayers(a: readonly PanelLayer[], b: readonly PanelLayer[]): boolean {
  return a.length === b.length && a.every((l, i) => l.name === b[i].name && l.color === b[i].color);
}

// ─── The 2D board ─────────────────────────────────────────────────────────

/** The board controls `DesignCanvasHandle` forwards. */
export interface CanvasBoardControls {
  layers(): LayerInfo[];
  setLayerVisible(name: string, visible: boolean): void;
  highlightLayer(name: string | null): void;
  setObjectOpacity(kind: ObjectClass2D, opacity: number): void;
  highlightNet(net: number | null): void;
}

/**
 * Bring the 2D board to `next`, calling only what differs. Returns false — and
 * does nothing — when no board is on screen (`layers()` answers []), because
 * every setter is a no-op then; the caller keeps its record of what the board
 * has and tries again on the next `layers` event.
 *
 * Visibility and the layer highlight are compared with what the board REPORTS
 * (its layer set is rebuilt on every load, so the report is the truth). Opacity
 * and the net highlight cannot be read back, so they are compared with
 * `applied` — what this function last got onto the board, null for a board
 * that has been given nothing yet (KiCanvas's defaults: full opacity, no net).
 * Opacity and net calls each redraw the board, which is why a re-apply after
 * the board's own echo sends none of them.
 */
export function applyToCanvas(canvas: CanvasBoardControls, applied: BoardViewState | null, next: BoardViewState): boolean {
  const live = canvas.layers();
  if (live.length === 0) return false;
  for (const layer of live) {
    const visible = !next.hiddenLayers.has(layer.name);
    if (layer.visible !== visible) canvas.setLayerVisible(layer.name, visible);
  }
  const lit = live.find((l) => l.highlighted)?.name ?? null;
  const wanted = next.highlightedLayer != null && live.some((l) => l.name === next.highlightedLayer) ? next.highlightedLayer : null;
  if (lit !== wanted) canvas.highlightLayer(wanted);
  for (const { kind } of CLASSES_2D) {
    const was = applied == null ? 1 : opacityOf(applied, kind);
    const now = opacityOf(next, kind);
    if (was !== now) canvas.setObjectOpacity(kind, now);
  }
  if ((applied?.highlightedNet ?? null) !== next.highlightedNet) canvas.highlightNet(next.highlightedNet);
  return true;
}
