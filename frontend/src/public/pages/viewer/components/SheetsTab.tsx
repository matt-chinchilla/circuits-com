// The Sheets tab (owner, 2026-09-22: the sheet names "are not clear that
// these are LAYERS and should therefore probably fall into select-able
// LAYERS in the sidebar (show an image of what each of them look like…
// like how Altium365 does)"). They are the schematic's SHEETS, and this is
// their list: one row per sheet with a picture of it read from the file
// (`sheetThumbnail.ts`), its name, and a mark on the root; the sheet on
// screen is current; a sheet the renderer cannot draw is listed but inert,
// with the reason. A click takes the reader to that sheet on the Schematic tab.
import type { SheetThumbnail } from '@public/services/kicad/sheetThumbnail';
import styles from './BoardPanel.module.scss';

export interface SheetRow {
  path: string;
  /** The name shown: the file's stem. */
  label: string;
  root: boolean;
  /** The renderer cannot draw this one (a basename twin). */
  dropped: boolean;
  /** The picture, or null before it has been read / for an unreadable file. */
  thumbnail: SheetThumbnail | null;
}

export interface SheetsTabProps {
  rows: readonly SheetRow[];
  /** The sheet on screen. */
  active: string;
  /** Why a dropped sheet is inert, read through aria-describedby. */
  droppedHint: string;
  onChoose: (path: string) => void;
}

/** Junctions as one path of 1mm squares, so a busy sheet is one node. */
function junctionPath(thumb: SheetThumbnail): string {
  const parts: string[] = [];
  for (const j of thumb.junctions) parts.push(`M${j.x - 0.5} ${j.y - 0.5}h1v1h-1Z`);
  return parts.join('');
}

/**
 * The picture of a sheet: the paper at its own aspect, the drawing as four
 * paths with non-scaling strokes, so a wire is one crisp pixel whatever the
 * thumbnail's size. Decorative — the row's name is the label.
 */
export function SheetThumb({ thumb }: { thumb: SheetThumbnail }) {
  const junctions = junctionPath(thumb);
  return (
    <svg
      className={styles.thumb}
      viewBox={`0 0 ${thumb.width} ${thumb.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-sheet-thumb=""
    >
      <rect className={styles.thumbPaper} x="0" y="0" width={thumb.width} height={thumb.height} />
      {thumb.sheets !== '' && <path className={styles.thumbSheets} d={thumb.sheets} vectorEffect="non-scaling-stroke" />}
      {thumb.symbols !== '' && <path className={styles.thumbSymbols} d={thumb.symbols} vectorEffect="non-scaling-stroke" />}
      {thumb.buses !== '' && <path className={styles.thumbBuses} d={thumb.buses} vectorEffect="non-scaling-stroke" />}
      {thumb.wires !== '' && <path className={styles.thumbWires} d={thumb.wires} vectorEffect="non-scaling-stroke" />}
      {junctions !== '' && <path className={styles.thumbJunctions} d={junctions} />}
    </svg>
  );
}

/** One node carries the reason for every dropped row; the rows point at it. */
const DROPPED_REASON_ID = 'viewer-unrenderable-sheet-reason';

export default function SheetsTab({ rows, active, droppedHint, onChoose }: SheetsTabProps) {
  const anyDropped = rows.some((r) => r.dropped);
  return (
    <div className={styles.sheets} role="group" aria-label="Sheets">
      {anyDropped && (
        <span id={DROPPED_REASON_ID} className={styles.srOnly}>
          {droppedHint}
        </span>
      )}
      {rows.map((row) => (
        <button
          key={row.path}
          type="button"
          className={styles.sheetRow}
          aria-current={active === row.path}
          aria-disabled={row.dropped || undefined}
          aria-describedby={row.dropped ? DROPPED_REASON_ID : undefined}
          title={row.dropped ? droppedHint : undefined}
          onClick={() => onChoose(row.path)}
        >
          <span className={styles.sheetPicture}>
            {row.thumbnail != null ? <SheetThumb thumb={row.thumbnail} /> : <span className={styles.thumbEmpty} aria-hidden="true" />}
          </span>
          <span className={styles.sheetText}>
            <span className={styles.sheetName}>{row.label}</span>
            {row.root && <span className={styles.sheetTag}>root</span>}
            {row.dropped && <span className={styles.sheetTag}>can&#8217;t be drawn</span>}
            {row.thumbnail != null && (
              <span className={styles.sheetMeta}>
                {row.thumbnail.counts.symbols.toLocaleString('en-US')} {row.thumbnail.counts.symbols === 1 ? 'symbol' : 'symbols'}
                {row.thumbnail.counts.sheets > 0 && `, ${row.thumbnail.counts.sheets} ${row.thumbnail.counts.sheets === 1 ? 'sub-sheet' : 'sub-sheets'}`}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
