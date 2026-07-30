// StatCard — headline number + 30-day ET sparkline.
//
// The sparkline is a real chart, not decoration: it is fed by
// `/dashboard/trends`, whose day axis is the SAME ET calendar the rest of the
// dashboard buckets on, and it has a hover readout. The old hand-rolled SVG
// had a synthetic 12-point axis with no dates and no tooltip.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { sparklineOption } from '@admin/components/charts/options';
import type { TrendPoint } from '@admin/types/admin';
import { shortDay, TONE_HEX, type Tone } from './format';
import styles from '../DashboardPage.module.scss';

export interface StatCardProps {
  label: string;
  /** Pre-formatted headline — the card never formats, so a "$0.00 / not
   *  monetized" placeholder and a real total go through the same component. */
  value: string;
  delta?: string | null;
  deltaDir?: 'up' | 'down';
  hint: string;
  series: readonly TrendPoint[];
  /** Drives BOTH the DOM rail (`var(--a-grad-*)` via the tone class) and the
   *  canvas stroke (the mirrored hex) — see `Tone` in ./format. */
  tone: Tone;
  /** Tooltip value formatter. Pass a MODULE-LEVEL function: a fresh arrow per
   *  render would rebuild the option object and redraw the chart every time. */
  valueFormat: (v: number) => string;
}

const TONE_CLASS: Record<Tone, string> = {
  green: styles.toneGreen,
  blue: styles.toneBlue,
  gold: styles.toneGold,
  purple: styles.tonePurple,
  slate: styles.toneSlate,
};

export default function StatCard({
  label,
  value,
  delta,
  deltaDir = 'up',
  hint,
  series,
  tone,
  valueFormat,
}: StatCardProps) {
  const option = useMemo(
    () =>
      sparklineOption({
        // The axis carries the ET day already formatted, so the tooltip title
        // needs no second date pass.
        data: series.map((p) => ({ day: shortDay(p.day), value: Number(p.value) || 0 })),
        color: TONE_HEX[tone],
        valueFormat,
      }),
    [series, tone, valueFormat],
  );

  return (
    <div className={`${styles.stat} ${TONE_CLASS[tone]}`}>
      <div className={styles.statHead}>
        <span className={styles.statLabel}>{label}</span>
        {delta && (
          <span className={`${styles.statDelta} ${deltaDir === 'up' ? styles.up : styles.down}`}>
            {deltaDir === 'up' ? '▲' : '▼'} {delta}
          </span>
        )}
      </div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statHint}>{hint}</div>
      {series.length >= 2 ? (
        <EChart option={option} className={styles.statSpark} style={{ height: 52 }} />
      ) : (
        <div className={styles.statSparkEmpty} aria-hidden="true" />
      )}
    </div>
  );
}
