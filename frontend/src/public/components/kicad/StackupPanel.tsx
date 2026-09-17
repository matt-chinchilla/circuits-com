// frontend/src/public/components/kicad/StackupPanel.tsx
// The owner's Altium 365 Viewer reference (docs/design-briefs/pcb-viewer-
// stackup-reference.md): cross-section, layer table, summary. A field the file
// does not carry is a dash; a board without a saved stackup says so and shows
// the copper layers and via counts the file does carry.
//
// Every number here is read from the file by `boardStackup` and arranged by
// `stackupLayout` — this component owns only the drawing box and the wording.
import { Fragment, useMemo } from 'react';
import type { BoardStackup, ViaType } from '@public/services/kicad/types';
import { bands, minHeightPx, summarize, tableRows, viaSpans, type Band, type BandKind } from './stackupLayout';
import styles from './StackupPanel.module.scss';

/**
 * The drawing box, in viewBox units.
 *
 * The svg is `width="100%"`, so ONE unit is not one pixel: everything inside
 * scales with the column. WIDTH is deliberately close to the narrowest column
 * the zones grid can hand it (its 220px floor), which keeps that scale near 1
 * rather than shrinking a 10-unit label into an unreadable 6px. A column ON
 * that floor scales the label to 8.46px, which is why `.zones` steps down to
 * two columns below $bp-tablet rather than holding three at their floors: the
 * figure gets 307px at 769px (11.8px labels) and 12.6px at a 390px phone, where
 * the grid has already reflowed to one column.
 *
 * HEIGHT is a starting point, not a promise: a stack with more rows than it can
 * floor is drawn in a taller box instead (see `height` below).
 */
const WIDTH = 260;
const HEIGHT = 240;
/** The board itself. Its left edge is where the leader lines land; the gutter
 *  to its left holds the labels, which are the widest text in the figure
 *  ("dielectric 1" is 12 characters of mono). */
const STACK_X = 96;
const STACK_W = 158;
const LABEL_X = 86;
const LEADER_X = 88;
/** Two label centres closer together than this would overlap at the font size
 *  `.label` sets. Kept here rather than in the stylesheet because it is
 *  geometry the placement below has to reason about, and the two are checked
 *  against each other by test. */
const LABEL_GAP = 12;
/** A via lane is drawn in from the board's RIGHT edge. Any lane the helper puts
 *  further in than this would escape the board's left edge and be drawn over
 *  the labels, which would read as a barrel through nothing. */
const LANE_LIMIT = STACK_W - 4;
/** A figure this file never carried. One constant rather than an em dash typed
 *  at each of the sites that need it — and a JS string rather than JSX text,
 *  which is the form edit tooling has mangled into visible escapes before. */
const ABSENT = '—';

/** Band kind → its class. A record rather than an interpolated class name, so
 *  a new `BandKind` is a type error here instead of a silently unstyled band. */
const BAND_CLASS: Record<BandKind, string> = {
  copper: 'bandCopper',
  dielectric: 'bandDielectric',
  mask: 'bandMask',
  other: 'bandOther',
};

/** Via type → its class, for the same reason. */
const VIA_CLASS: Record<ViaType, string> = {
  through: 'viaThrough',
  blind: 'viaBlind',
  micro: 'viaMicro',
  unknown: 'viaUnknown',
};

const centreOf = (b: Band): number => b.y + b.h / 2;

/**
 * Which bands can carry a leader label without colliding.
 *
 * A real board defeats "label every row": Glasgow's 13 rows put three ~67-unit
 * dielectrics beside eight rows of 1-7 units, so the silk, paste, mask and
 * copper labels at each face land within a few units of one another and render
 * as a smear. Copper is offered a label FIRST because those rows are the stack's
 * anatomy and the dielectrics between them hold them apart; everything else
 * takes a label only if it still clears every label already placed.
 *
 * Nothing is lost by a row going unlabelled — the table beside the figure names
 * every row, which is what its caption says.
 *
 * Exported for test: this is the one piece of the panel a DOM assertion cannot
 * measure, because happy-dom has no layout.
 */
export function labelledBands(drawn: Band[], minGap: number = LABEL_GAP): Band[] {
  const offered = [...drawn.filter((b) => b.kind === 'copper'), ...drawn.filter((b) => b.kind !== 'copper')];
  const placed: number[] = [];
  const kept = new Set<Band>();
  for (const band of offered) {
    const centre = centreOf(band);
    if (placed.some((y) => Math.abs(y - centre) < minGap)) continue;
    placed.push(centre);
    kept.add(band);
  }
  // Back into file order, so the DOM reads top of the board downwards.
  return drawn.filter((b) => kept.has(b));
}

/**
 * Is the figure honestly to scale?
 *
 * `bands` weighs a row by its thickness, but falls back to equal bands when NO
 * row carries one — with no stackup block at all, and also for a block whose
 * every thickness is absent or zero. Claiming "drawn to scale" over equal bands
 * would be the one thing this panel exists not to do.
 */
function toScale(s: BoardStackup): boolean {
  return s.stackup != null && s.stackup.some((r) => r.thicknessMm != null && r.thicknessMm > 0);
}

/**
 * The copper finish, as a reader should see it.
 *
 * KiCad writes `(copper_finish "None")` on every board in our corpus, so this
 * is the common case and not an edge one. "None" is the file SAYING the finish
 * is none — a different fact from the field being absent, which is why the
 * reader keeps them apart and the wording here does too.
 */
function finishLabel(finish: string | null): string {
  if (finish == null) return ABSENT;
  const trimmed = finish.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return 'none specified';
  return trimmed;
}

interface StackupPanelProps {
  stackup: BoardStackup;
}

export default function StackupPanel({ stackup }: StackupPanelProps) {
  const rows = useMemo(() => tableRows(stackup), [stackup]);
  const summary = useMemo(() => summarize(stackup), [stackup]);
  // Never shorter than the floors `bands` reserves. With HEIGHT at 240 this is
  // the identity for any real board (Glasgow's floor is 22), and it is here so
  // that a box made responsive later cannot start drawing rows outside the
  // viewBox without anything failing.
  const height = useMemo(() => Math.max(HEIGHT, minHeightPx(stackup)), [stackup]);
  const drawn = useMemo(() => bands(stackup, height), [stackup, height]);
  const spans = useMemo(() => viaSpans(stackup, drawn), [stackup, drawn]);
  const labels = useMemo(() => labelledBands(drawn), [drawn]);
  const lanes = spans.filter((v) => v.x <= LANE_LIMIT);
  const undrawnLanes = spans.length - lanes.length;
  const missing = stackup.stackup == null;
  const scaled = toScale(stackup);
  const buckets = ([
    ['Signal', summary.signal],
    ['Plane', summary.plane],
    ['Mixed', summary.mixed],
    ['Jumper', summary.jumper],
    ['Other', summary.other],
  ] as [string, number][]).filter((b) => b[1] > 0);

  return (
    <section className={styles.panel} aria-label="Board stackup">
      {missing && (
        <p className={styles.missing}>
          No Board Setup saved &mdash; this board carries no physical stackup (Board Setup &rarr; Physical
          Stackup in KiCad), so there are no thicknesses to draw it to scale by. The copper layers and via
          counts below are what the file does carry.
        </p>
      )}
      <div className={styles.zones}>
        <figure className={styles.section}>
          <svg
            className={styles.svg}
            viewBox={`0 0 ${WIDTH} ${height}`}
            width="100%"
            role="img"
            aria-label={
              scaled
                ? 'Cross-section of the board stack, drawn to scale. The layer table beside it carries the same rows as text.'
                : 'Cross-section of the board stack, drawn as equal bands because the file records no thicknesses. The layer table beside it carries the same rows as text.'
            }
          >
            {drawn.map((b) => (
              <rect
                key={`${b.name}-${b.y}`}
                className={styles[BAND_CLASS[b.kind]]}
                x={STACK_X}
                y={b.y}
                width={STACK_W}
                height={b.h}
              />
            ))}
            {labels.map((b) => (
              <g key={`label-${b.name}-${b.y}`}>
                <line className={styles.leader} x1={LEADER_X} y1={centreOf(b)} x2={STACK_X} y2={centreOf(b)} />
                <text className={styles.label} x={LABEL_X} y={centreOf(b)} textAnchor="end" dominantBaseline="middle">
                  {b.name}
                </text>
              </g>
            ))}
            {lanes.map((v, i) => (
              <g key={`${v.type}-${v.y1}-${v.y2}-${i}`} className={styles[VIA_CLASS[v.type]]}>
                <line
                  x1={STACK_X + STACK_W - v.x}
                  y1={v.y1}
                  x2={STACK_X + STACK_W - v.x}
                  y2={v.y2}
                />
                <title>{`${v.count} ${v.type} via${v.count === 1 ? '' : 's'}`}</title>
              </g>
            ))}
          </svg>
          <figcaption className={styles.caption}>
            {scaled
              ? 'Drawn to scale from the thicknesses in the file.'
              : 'Equal bands — this file records no thicknesses to draw them to scale by.'}{' '}
            Every row is named in the table.
          </figcaption>
        </figure>

        {rows.length === 0 ? (
          <p className={styles.missing}>This board file lists no copper layers.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Layer</th>
                <th scope="col">Type</th>
                <th scope="col">Thk (mm)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.layer}-${i}`}>
                  <td className={styles.num}>{r.ordinal}</td>
                  <td>{r.layer}</td>
                  <td>{r.type}</td>
                  <td className={styles.num}>{r.thk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <dl className={styles.summary}>
          <dt>Total layers</dt>
          <dd>{summary.total}</dd>
          {buckets.map(([label, n]) => (
            // A Fragment, not a wrapper: `.summary` is a two-column grid, and
            // any real element here would take one cell and swallow the pair.
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </Fragment>
          ))}
          <dt>Dielectric</dt>
          <dd>{summary.dielectric}</dd>
          <dt>Listed thickness</dt>
          <dd>{summary.listed ?? ABSENT}</dd>
          {summary.design != null && (
            <>
              <dt>Design thickness</dt>
              <dd>{summary.design}</dd>
            </>
          )}
          <dt>Copper finish</dt>
          <dd>{finishLabel(summary.finish)}</dd>
          <dt>Thru vias</dt>
          <dd>{summary.thru}</dd>
          <dt>Blind/Buried vias</dt>
          <dd>{summary.blindBuried}</dd>
          <dt>Micro vias</dt>
          <dd>{summary.micro}</dd>
          {summary.unknown > 0 && (
            <>
              <dt>Unknown via type</dt>
              <dd>{summary.unknown}</dd>
            </>
          )}
        </dl>
      </div>
      <p className={styles.footnote}>
        Listed thickness is the sum of the thicknesses in the stackup block; design thickness is the board
        setting. KiCad&rsquo;s file does not distinguish blind from buried vias.
        {summary.other > 0 && ' Other counts copper layers set to a kind this reader has no name for; the table shows what the file calls each one.'}
        {undrawnLanes > 0 &&
          ` ${undrawnLanes} more via group${undrawnLanes === 1 ? '' : 's'} ${undrawnLanes === 1 ? 'is' : 'are'} counted here but left out of the figure, which has room for ${lanes.length}.`}
      </p>
    </section>
  );
}
