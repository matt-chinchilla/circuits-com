import { useState } from 'react';
import styles from './CoverageStrip.module.scss';

/**
 * The honest number, first thing on the page.
 *
 * A pricing tool that shows a table and no coverage figure invites the reader
 * to assume the table is the whole BOM. It usually is not: most KiCad exports
 * carry no MPN at all, so a real file lands with a mix of exact hits, family
 * matches and lines nothing could be said about. This strip states that mix
 * before the first row is read.
 *
 * Every chip carries a WORD and a GLYPH as well as its colour — the counts
 * must survive a colour-blind reader and a greyscale print (the same rule the
 * Leads outcome trio follows).
 */

export interface CoverageCounts {
  /** Lines counted at all (DNP lines are excluded upstream). */
  total: number;
  /** Lines that ended with a price we could compute. */
  priced: number;
  exact: number;
  approx: number;
  live: number;
  notFound: number;
}

/** A build of 100k of anything is a typo, and the ext-price column stops
 *  being readable long before it. Cap rather than let the math run away. */
export const MAX_BUILD_QTY = 100000;

/** Segment width for the coverage gauge. Zero total renders zero-width
 *  segments — the empty well, never NaN%. */
function pct(count: number, total: number): string {
  return total > 0 ? `${(count / total) * 100}%` : '0%';
}

/** The gauge said out loud, for readers who cannot see the textures. */
function gaugeLabel(counts: CoverageCounts): string {
  return (
    `Coverage: ${counts.exact} exact, ${counts.approx} approximate, ` +
    `${counts.live} sourced live, ${counts.notFound} not found, of ${counts.total} lines`
  );
}

interface CoverageStripProps {
  counts: CoverageCounts;
  buildQty: number;
  onBuildQtyChange: (qty: number) => void;
  /** How many lines the file marked DNP, included or not. Zero hides the
   *  toggle entirely — a control for something that is not there is noise. */
  dnpCount: number;
  includeDnp: boolean;
  onIncludeDnpChange: (include: boolean) => void;
}

export default function CoverageStrip({
  counts,
  buildQty,
  onBuildQtyChange,
  dnpCount,
  includeDnp,
  onIncludeDnpChange,
}: CoverageStripProps) {
  // The input keeps its own draft so the field can be emptied mid-edit; the
  // committed quantity only ever moves to a real number.
  const [draft, setDraft] = useState(String(buildQty));

  const handleChange = (text: string) => {
    setDraft(text);
    const parsed = Number.parseInt(text, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      onBuildQtyChange(Math.min(parsed, MAX_BUILD_QTY));
    }
  };

  const handleBlur = () => {
    const parsed = Number.parseInt(draft, 10);
    const settled = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_BUILD_QTY) : 1;
    onBuildQtyChange(settled);
    setDraft(String(settled));
  };

  return (
    <section className={styles.strip} aria-label="BOM coverage">
      <div className={styles.headline}>
        <p className={styles.count}>
          <span className={styles.countBig}>
            {counts.priced.toLocaleString('en-US')} of {counts.total.toLocaleString('en-US')}
          </span>{' '}
          {counts.total === 1 ? 'line' : 'lines'} priced
        </p>

        <label className={styles.qty} htmlFor="bom-build-qty">
          <span className={styles.qtyLabel}>Build quantity</span>
          <input
            id="bom-build-qty"
            className={styles.qtyInput}
            type="number"
            min={1}
            max={MAX_BUILD_QTY}
            step={1}
            inputMode="numeric"
            value={draft}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
          />
          <span className={styles.qtyUnit}>{buildQty === 1 ? 'board' : 'boards'}</span>
        </label>
      </div>

      {/* The recessed gauge: the coverage mix as widths, in the same textures
          the badges use (solid = exact, hatch = approx, gold = sourced live,
          white = not found). A remainder mid-resolve stays as the empty well —
          the bar only ever claims settled lines. */}
      <div className={styles.well} role="img" aria-label={gaugeLabel(counts)}>
        <span className={styles.segExact} style={{ width: pct(counts.exact, counts.total) }} />
        <span className={styles.segApprox} style={{ width: pct(counts.approx, counts.total) }} />
        <span className={styles.segLive} style={{ width: pct(counts.live, counts.total) }} />
        <span className={styles.segNone} style={{ width: pct(counts.notFound, counts.total) }} />
      </div>

      <ul className={styles.legend}>
        <li className={styles.legendItem}>
          <span className={`${styles.sw} ${styles.swExact}`} aria-hidden="true" />
          <span className={styles.legendNum}>{counts.exact.toLocaleString('en-US')}</span>
          <span className={styles.legendWord}>exact</span>
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.sw} ${styles.swApprox}`} aria-hidden="true" />
          <span className={styles.legendNum}>{counts.approx.toLocaleString('en-US')}</span>
          <span className={styles.legendWord}>approximate</span>
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.sw} ${styles.swLive}`} aria-hidden="true" />
          <span className={styles.legendNum}>{counts.live.toLocaleString('en-US')}</span>
          <span className={styles.legendWord}>sourced live</span>
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.sw} ${styles.swNone}`} aria-hidden="true" />
          <span className={styles.legendNum}>{counts.notFound.toLocaleString('en-US')}</span>
          <span className={styles.legendWord}>not found</span>
        </li>
      </ul>

      {/* DNP lines default OUT: a "do not populate" line is a line nobody is
          buying, so counting it would inflate every figure above and the
          build total below. The toggle is here rather than in the table
          because it changes what the coverage numbers MEAN, and the reader
          should see both move together. */}
      {dnpCount > 0 && (
        <label className={styles.dnp}>
          <input
            type="checkbox"
            className={styles.dnpBox}
            checked={includeDnp}
            onChange={(e) => onIncludeDnpChange(e.target.checked)}
          />
          <span className={styles.dnpLabel}>
            Include the {dnpCount.toLocaleString('en-US')} DNP{' '}
            {dnpCount === 1 ? 'line' : 'lines'}
          </span>
          <span className={styles.dnpHint}>
            {includeDnp
              ? 'Counted and priced with the rest of the build.'
              : 'Shown greyed, out of the totals, and never looked up live.'}
          </span>
        </label>
      )}
    </section>
  );
}
