// KiCanvas's board layer palette, copied as CSS strings so a host can list a
// board's layers — in the colours the Board tab draws them — before any
// renderer has loaded (the 3D tab, a board not yet opened).
//
// Source: the "kicad" theme the controller mounts the embed with
// (`theme="kicad"`), vendor src/kicanvas/themes/kicad-default.ts, its `board`
// block. KiCanvas is MIT-licensed; the copy is recorded in
// public/vendor/kicanvas/NOTICE.txt under the KiCanvas block. Every value is
// written exactly as upstream's `Color.to_css()` prints it (vendor
// src/base/color.ts), so a colour read off a live board and one read from this
// table are the same string. Keys are KiCad's canonical layer names, mapped to
// theme keys the way upstream's `LayerSet.color_for` does (vendor
// src/viewers/board/layers.ts): `F.Cu` → `copper.f`, `F.SilkS` → `f_silks`.
// Key order is upstream's own layer-panel order (`LayerSet.in_ui_order`).
import type { LayerInfo, LayerKind } from './canvasController';

export const BOARD_LAYER_COLORS: Readonly<Record<string, string>> = Object.freeze({
  'F.Cu': 'rgba(200, 52, 52, 1)',
  'In1.Cu': 'rgba(127, 200, 127, 1)',
  'In2.Cu': 'rgba(206, 125, 44, 1)',
  'In3.Cu': 'rgba(79, 203, 203, 1)',
  'In4.Cu': 'rgba(219, 98, 139, 1)',
  'In5.Cu': 'rgba(167, 165, 198, 1)',
  'In6.Cu': 'rgba(40, 204, 217, 1)',
  'In7.Cu': 'rgba(232, 178, 167, 1)',
  'In8.Cu': 'rgba(242, 237, 161, 1)',
  'In9.Cu': 'rgba(141, 203, 129, 1)',
  'In10.Cu': 'rgba(237, 124, 51, 1)',
  'In11.Cu': 'rgba(91, 195, 235, 1)',
  'In12.Cu': 'rgba(247, 111, 142, 1)',
  'In13.Cu': 'rgba(167, 165, 198, 1)',
  'In14.Cu': 'rgba(40, 204, 217, 1)',
  'In15.Cu': 'rgba(232, 178, 167, 1)',
  'In16.Cu': 'rgba(242, 237, 161, 1)',
  'In17.Cu': 'rgba(237, 124, 51, 1)',
  'In18.Cu': 'rgba(91, 195, 235, 1)',
  'In19.Cu': 'rgba(247, 111, 142, 1)',
  'In20.Cu': 'rgba(167, 165, 198, 1)',
  'In21.Cu': 'rgba(40, 204, 217, 1)',
  'In22.Cu': 'rgba(232, 178, 167, 1)',
  'In23.Cu': 'rgba(242, 237, 161, 1)',
  'In24.Cu': 'rgba(237, 124, 51, 1)',
  'In25.Cu': 'rgba(91, 195, 235, 1)',
  'In26.Cu': 'rgba(247, 111, 142, 1)',
  'In27.Cu': 'rgba(167, 165, 198, 1)',
  'In28.Cu': 'rgba(40, 204, 217, 1)',
  'In29.Cu': 'rgba(232, 178, 167, 1)',
  'In30.Cu': 'rgba(242, 237, 161, 1)',
  'B.Cu': 'rgba(77, 127, 196, 1)',
  'F.Adhes': 'rgba(132, 0, 132, 1)',
  'B.Adhes': 'rgba(0, 0, 132, 1)',
  'F.Paste': 'rgba(180, 160, 154, 0.902)',
  'B.Paste': 'rgba(0, 194, 194, 0.902)',
  'F.SilkS': 'rgba(242, 237, 161, 1)',
  'B.SilkS': 'rgba(232, 178, 167, 1)',
  'F.Mask': 'rgba(216, 100, 255, 0.4)',
  'B.Mask': 'rgba(2, 255, 238, 0.4)',
  'Dwgs.User': 'rgba(194, 194, 194, 1)',
  'Cmts.User': 'rgba(89, 148, 220, 1)',
  'Eco1.User': 'rgba(180, 219, 210, 1)',
  'Eco2.User': 'rgba(216, 200, 82, 1)',
  'Edge.Cuts': 'rgba(208, 210, 205, 1)',
  Margin: 'rgba(255, 38, 226, 1)',
  'F.CrtYd': 'rgba(255, 38, 226, 1)',
  'B.CrtYd': 'rgba(38, 233, 255, 1)',
  'F.Fab': 'rgba(175, 175, 175, 1)',
  'B.Fab': 'rgba(88, 93, 132, 1)',
  'User.1': 'rgba(194, 194, 194, 1)',
  'User.2': 'rgba(89, 148, 220, 1)',
  'User.3': 'rgba(180, 219, 210, 1)',
  'User.4': 'rgba(216, 200, 82, 1)',
  'User.5': 'rgba(194, 194, 194, 1)',
  'User.6': 'rgba(89, 148, 220, 1)',
  'User.7': 'rgba(180, 219, 210, 1)',
  'User.8': 'rgba(216, 200, 82, 1)',
  'User.9': 'rgba(232, 178, 167, 1)',
});

/** Upstream's own fallback for a layer its theme has no entry for
 *  (`?? Color.white` in `LayerSet.color_for`), as `to_css()` prints it. */
export const FALLBACK_LAYER_COLOR = 'rgba(255, 255, 255, 1)';

/** The default colour of a physical board layer, or null for a name the palette
 *  does not know (a virtual layer, a misspelling). */
export function layerColor(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(BOARD_LAYER_COLORS, name) ? BOARD_LAYER_COLORS[name]! : null;
}

/** What a physical layer is for, read off its canonical name. */
export function layerKind(name: string): LayerKind {
  if (/\.Cu$/.test(name)) return 'copper';
  if (/\.Mask$/.test(name)) return 'mask';
  if (/\.Paste$/.test(name)) return 'paste';
  if (/\.SilkS$/.test(name)) return 'silk';
  if (/\.CrtYd$/.test(name)) return 'courtyard';
  if (/\.Fab$/.test(name)) return 'fab';
  if (name === 'Edge.Cuts') return 'edge';
  if (/\.User$/.test(name) || /^User\.\d+$/.test(name)) return 'user';
  return 'other';
}

/** Which face a layer belongs to: the `F.`/`B.` prefixes, `In<n>.Cu` inner
 *  copper, null for board-wide layers (Edge.Cuts, Margin, the user layers). */
export function layerSide(name: string): LayerInfo['side'] {
  if (name.startsWith('F.')) return 'F';
  if (name.startsWith('B.')) return 'B';
  if (/^In\d+\.Cu$/.test(name)) return 'In';
  return null;
}
