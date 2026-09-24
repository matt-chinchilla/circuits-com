// The /viewer guide's facts, as data. Every number, file type and refusal the
// guide prints is READ from the code that enforces it (INTAKE_CAPS, the
// extension lists, MIN_KICAD_VERSION, the reader's own refusal sentences), so
// a change to a rule changes the page. Tests pin the rest: the folder's roles
// against the reader itself, the "left out" rows against the reader's filter, and
// the pricing disclosure against the request the BOM tool really sends.
import type { MatchLineIn } from '@public/services/bom/types';
import { INTAKE_MESSAGES } from '@public/services/kicad/project';
import { INTAKE_CAPS, KICAD5_MESSAGE, MIN_KICAD_VERSION, formatMb } from '@public/services/kicad/types';
import { KICAD_FILES_PROSE, rejectionCopy } from '../../intakeCopy';
import { VIEW_LABEL, type ViewId } from '../../viewLabels';

/** The binding sentence (owner, CLAUDE.md). Verbatim, everywhere it appears. */
export const PRIVACY_SENTENCE = 'Your design files never leave your browser.';

/**
 * What the BOM's pricing call sends per line, in the order the guide says it.
 * Keyed by the request's own field names, so a field added to MatchLineIn is a
 * type error here until the disclosure names it (and a test compares the keys
 * of a REAL request body against this list).
 */
export const PRICING_FIELDS: Record<Exclude<keyof MatchLineIn, 'index'>, string> = {
  mpn: 'part number',
  manufacturer: 'manufacturer',
  value: 'value',
  footprint: 'footprint',
  description: 'description',
};

/** The three wires on the sheet: which files feed which outputs. */
export type Net = 'pro' | 'sch' | 'pcb';

export const NET_LABEL: Record<Net, string> = { pro: 'project', sch: 'sheets', pcb: 'board' };

export interface FolderFile {
  name: string;
  role: string;
  net: Net;
}

/**
 * The folder the sheet draws: an ILLUSTRATIVE KiCad project, named generically
 * so a visitor reads it as their own (owner, 2026-09-24) — not the example the
 * "Try the example project" button loads, which the credit line names. KiCad
 * names the root sheet, the board and the local settings after the project,
 * and so does this. A test builds a project from these names with the real
 * reader and proves every role it labels.
 */
export const PROJECT_NAME = 'my-board';

export const EXAMPLE_FOLDER = `${PROJECT_NAME}/`;

export const EXAMPLE_FILES: readonly FolderFile[] = [
  { name: `${PROJECT_NAME}.kicad_pro`, role: 'project', net: 'pro' },
  { name: `${PROJECT_NAME}.kicad_sch`, role: 'root sheet', net: 'sch' },
  { name: 'power.kicad_sch', role: 'sub-sheet', net: 'sch' },
  { name: 'usb.kicad_sch', role: 'sub-sheet', net: 'sch' },
  { name: `${PROJECT_NAME}.kicad_pcb`, role: 'board', net: 'pcb' },
];

export interface LeftOutEntry {
  name: string;
  role: string;
  folder: boolean;
  /** A path inside a zip of the folder that stands for this row — the reader's
   *  own filter must refuse it (pinned by a test). */
  probe: string;
}

/** What else a KiCad project folder usually holds, none of which is read. */
export const LEFT_OUT: readonly LeftOutEntry[] = [
  { name: `${PROJECT_NAME}.kicad_prl`, role: 'your local settings', folder: false, probe: `${EXAMPLE_FOLDER}${PROJECT_NAME}.kicad_prl` },
  { name: 'fp-info-cache', role: 'library cache', folder: false, probe: `${EXAMPLE_FOLDER}fp-info-cache` },
  {
    name: `${PROJECT_NAME}-backups/`,
    role: 'KiCad backups',
    folder: true,
    // KiCad's own backup name: <project>-YYYY-MM-DD_HHMMSS.zip.
    probe: `${EXAMPLE_FOLDER}${PROJECT_NAME}-backups/${PROJECT_NAME}-2026-09-12_195300.zip`,
  },
  { name: 'gerbers/', role: 'manufacturing outputs', folder: true, probe: `${EXAMPLE_FOLDER}gerbers/${PROJECT_NAME}-F_Cu.gbr` },
  { name: `${PROJECT_NAME}.step`, role: '3D model', folder: false, probe: `${EXAMPLE_FOLDER}${PROJECT_NAME}.step` },
  { name: 'LICENSE', role: 'not a KiCad file', folder: false, probe: `${EXAMPLE_FOLDER}LICENSE` },
];

/**
 * The part the tour follows across the views — the example's FPGA. Its closing
 * link opens the example with this reference selected (the page's own `#ref`
 * path), so the tour ends on the thing it just taught, not on a second copy of
 * the "Try the example project" button that is docked beside it anyway.
 */
export const TOUR_REF = 'U30';

export interface GuideImage {
  src: string;
  /** The file's own pixel size — the box is reserved before it loads. */
  width: number;
  height: number;
  alt: string;
}

/** Real captures of this viewer on the example, from production — see
 *  frontend/scripts/viewer-guide/README.md for how they are re-taken. */
export const IMAGES = {
  schematic: { src: '/viewer-guide/schematic.webp', width: 360, height: 242, alt: 'The example project’s root schematic sheet, open in the viewer' },
  bom: { src: '/viewer-guide/bom.webp', width: 420, height: 232, alt: 'Lines of the example project’s BOM with their catalog matches and distributor offers' },
  board: { src: '/viewer-guide/board-u30.webp', width: 600, height: 415, alt: 'The example board’s copper and silkscreen around the FPGA, U30' },
  stackup: { src: '/viewer-guide/stackup.webp', width: 360, height: 155, alt: 'The example board’s four-layer stackup, drawn to scale beside its layer table' },
  board3d: { src: '/viewer-guide/board-3d-u30.webp', width: 820, height: 581, alt: 'The example board in 3D, with U30 lit in cyan and labelled with its part number' },
  // The tour: U30 followed across the views (tour-*). Sized for the tour's
  // largest frame at 2x; partTour.test.ts holds the frame sizes (LARGEST_BOX).
  tour3d: {
    src: '/viewer-guide/tour-3d-u30.webp',
    width: 1680,
    height: 1120,
    alt: 'The example board in 3D, close in on the FPGA U30: its body lit in cyan and labelled with its part number',
  },
  tourSchematic: {
    src: '/viewer-guide/tour-schematic-u30.webp',
    width: 1280,
    height: 800,
    alt: 'U30’s unit on the schematic, shaded as the selected part, with its designator and part number',
  },
  tourBoard: {
    src: '/viewer-guide/tour-board-u30.webp',
    width: 1280,
    height: 800,
    alt: 'The board view centred on U30’s ball-grid footprint, highlighted',
  },
  tourPanel: {
    src: '/viewer-guide/tour-panel-u30.webp',
    width: 1005,
    height: 1689,
    alt: 'The part panel for U30: side, position and rotation from the board file, then its exact catalog match from Lattice',
  },
} satisfies Record<string, GuideImage>;

export interface Output {
  key: string;
  net: Net;
  title: string;
  body?: string;
  from: string;
  image?: GuideImage;
}

const title = (id: ViewId): string => VIEW_LABEL[id];

/** "What each file becomes" — titles are the workspace's own tab names. */
export const OUTPUTS: readonly Output[] = [
  { key: 'project', net: 'pro', title: 'The project’s name and which sheet is the root', from: 'from .kicad_pro' },
  {
    key: 'schematic',
    net: 'sch',
    title: title('schematic'),
    body: 'Every sheet, pannable and zoomable, with a picture of each sheet to jump between them.',
    from: 'from each .kicad_sch',
    image: IMAGES.schematic,
  },
  {
    key: 'bom',
    net: 'sch',
    title: title('bom'),
    body: 'One line per part, matched against our distributor catalog. DNP parts stay out of the totals.',
    from: 'from each .kicad_sch',
    image: IMAGES.bom,
  },
  {
    key: 'board',
    net: 'pcb',
    title: title('board'),
    body: 'Copper, silkscreen and every other layer, drawn the way KiCad draws them.',
    from: 'from .kicad_pcb',
    image: IMAGES.board,
  },
  {
    key: 'stackup',
    net: 'pcb',
    title: title('stackup'),
    body: 'Layers, materials and thicknesses, drawn to scale.',
    from: 'from .kicad_pcb',
    image: IMAGES.stackup,
  },
  {
    key: 'board3d',
    net: 'pcb',
    title: title('board3d'),
    body: 'The assembled board you can turn over. Body heights are estimated from the footprints.',
    from: 'from .kicad_pcb',
    image: IMAGES.board3d,
  },
];

/** formatMb's figure without a trailing ".0" — "8 MB", not "8.0 MB", in prose. */
export function proseMb(bytes: number): string {
  return formatMb(bytes).replace(/\.0$/, '');
}

/** The caps line and note 4, in the reader's own units. */
export const CAPS = {
  files: INTAKE_CAPS.files,
  perFileMb: proseMb(INTAKE_CAPS.perFileBytes),
  totalMb: proseMb(INTAKE_CAPS.totalBytes),
  minKicad: MIN_KICAD_VERSION,
};

export { KICAD_FILES_PROSE };

/** The truth table's rows: what a drop holds → which views open. */
export const DROP_KINDS: readonly { label: string; schematic: boolean; board: boolean }[] = [
  { label: 'Schematic sheets only', schematic: true, board: false },
  { label: 'A board only', schematic: false, board: true },
  { label: 'Both, or a zip of the folder', schematic: true, board: true },
];

const MB = 1024 * 1024;

/**
 * "What a turned-away file looks like": the refusals a visitor is most likely
 * to meet, printed from the reader's OWN sentences — never retyped here.
 */
export const REFUSALS: readonly { what: string; message: string }[] = [
  { what: 'A Gerber file on its own', message: rejectionCopy(`${PROJECT_NAME}-F_Cu.gbr`) },
  { what: 'A 3D model on its own', message: rejectionCopy(`${PROJECT_NAME}.step`) },
  { what: 'A zip of Gerbers or other outputs', message: INTAKE_MESSAGES.empty },
  { what: `A KiCad ${MIN_KICAD_VERSION - 1} project`, message: KICAD5_MESSAGE },
  { what: 'Too many KiCad files', message: INTAKE_MESSAGES.tooManyFiles(INTAKE_CAPS.files + 8) },
  { what: 'A board over the size limit', message: INTAKE_MESSAGES.fileTooLarge(`${PROJECT_NAME}.kicad_pcb`, INTAKE_CAPS.perFileBytes + 1.4 * MB) },
];
