import { useMemo, useState } from 'react';
import { buildInventoryHistory } from './partSynth';
import styles from './PartPage.module.scss';

// Native-SVG inventory trace (house rule: no charting library). One 365-day
// deterministic series per part; the presets only WINDOW it, so toggling
// never re-rolls the curve.

const PRESETS = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];

const W = 640;
const H = 220;
const M = { top: 14, right: 14, bottom: 26, left: 52 };

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function dateLabel(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function InventoryChart({
  seedKey,
  currentStock,
}: {
  seedKey: string;
  currentStock: number;
}) {
  const [days, setDays] = useState(90);
  const series = useMemo(
    () => buildInventoryHistory(seedKey, currentStock),
    [seedKey, currentStock],
  );

  // Oldest → newest, left → right. slice() already returns a fresh array,
  // so reversing in place never touches the memoized series.
  const windowed = series.slice(0, days + 1).reverse();
  const maxStock = Math.max(1, ...windowed.map(p => p.stock));
  const yMax = maxStock * 1.15;

  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (i: number) => M.left + (i / (windowed.length - 1)) * plotW;
  const y = (stock: number) => M.top + plotH - (stock / yMax) * plotH;

  const line = windowed.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.stock).toFixed(1)}`).join(' ');
  const area = `${line} L${(M.left + plotW).toFixed(1)},${(M.top + plotH).toFixed(1)} L${M.left},${(M.top + plotH).toFixed(1)} Z`;

  const gridRows = [0.25, 0.5, 0.75, 1].map(f => ({
    yPos: M.top + plotH - f * plotH,
    value: f * yMax,
  }));
  const xTicks = [days, Math.round(days / 2), 0];

  return (
    <div>
      <div className={styles.presetRow} role="group" aria-label="History range">
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            className={styles.presetBtn}
            aria-pressed={days === p.days}
            onClick={() => setDays(p.days)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <svg
        className={styles.chartSvg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Estimated stock over the last ${days} days, currently ${currentStock.toLocaleString()} units`}
      >
        {gridRows.map(g => (
          <g key={g.yPos}>
            <line
              className={styles.chartGrid}
              x1={M.left}
              y1={g.yPos}
              x2={W - M.right}
              y2={g.yPos}
            />
            <text className={styles.chartTick} x={M.left - 8} y={g.yPos + 3} textAnchor="end">
              {compact(g.value)}
            </text>
          </g>
        ))}
        {xTicks.map((d, i) => (
          <text
            key={d}
            className={styles.chartTick}
            x={M.left + (i / (xTicks.length - 1)) * plotW}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
          >
            {dateLabel(d)}
          </text>
        ))}
        <path className={styles.chartArea} d={area} />
        <path className={styles.chartLine} d={line} />
        <circle
          className={styles.chartDot}
          cx={x(windowed.length - 1)}
          cy={y(windowed[windowed.length - 1].stock)}
          r="3.5"
        />
      </svg>
      <p className={styles.chartCaption}>
        Estimated from current distributor stock — live tracking lands with the price-feed
        integration.
      </p>
    </div>
  );
}
