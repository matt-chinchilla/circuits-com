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

interface CoverageStripProps {
  counts: CoverageCounts;
  buildQty: number;
  onBuildQtyChange: (qty: number) => void;
}

export default function CoverageStrip({ counts, buildQty, onBuildQtyChange }: CoverageStripProps) {
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
        </label>
      </div>

      <ul className={styles.chips}>
        <li className={`${styles.chip} ${styles.chipExact}`}>
          <span className={styles.glyph} aria-hidden="true">
            &#10003;
          </span>
          <span className={styles.chipNum}>{counts.exact.toLocaleString('en-US')}</span>
          <span className={styles.chipWord}>exact</span>
        </li>
        <li className={`${styles.chip} ${styles.chipApprox}`}>
          <span className={styles.glyph} aria-hidden="true">
            &#8776;
          </span>
          <span className={styles.chipNum}>{counts.approx.toLocaleString('en-US')}</span>
          <span className={styles.chipWord}>approximate</span>
        </li>
        <li className={`${styles.chip} ${styles.chipLive}`}>
          <span className={styles.glyph} aria-hidden="true">
            &#9679;
          </span>
          <span className={styles.chipNum}>{counts.live.toLocaleString('en-US')}</span>
          <span className={styles.chipWord}>live</span>
        </li>
        <li className={`${styles.chip} ${styles.chipNone}`}>
          <span className={styles.glyph} aria-hidden="true">
            &#215;
          </span>
          <span className={styles.chipNum}>{counts.notFound.toLocaleString('en-US')}</span>
          <span className={styles.chipWord}>not found</span>
        </li>
      </ul>
    </section>
  );
}
