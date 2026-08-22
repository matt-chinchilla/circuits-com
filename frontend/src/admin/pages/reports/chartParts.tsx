// Shared presentational pieces for the Reports page's hand-rolled SVG
// charts: the hit-rect hover/pin grid, the crosshair, the positioned
// tooltip wrapper, and the axis tick/label text. Each chart keeps its own
// scales, paths, dots, and tooltip row content — only the parts that were
// hand-copied verbatim across charts live here.

import type { ReactNode } from 'react'
import type { TooltipAnchor } from './chartKit'
import styles from './ReportsPage.module.scss'

// ── Instrument-zone constants (design pass 2026-08-21) ──────────────────────
// Series trio validated (adjacent + all-pairs) on the zone surface #0f1526:
// cyan #2299bf · violet #8467e0 · gold #a8842e. The primary line wears a
// cyan→brand-green gradient stroke (one series, one identity — the legend
// chip carries the same gradient). Grid/axis inks are fixed, not chrome
// tokens, so the validated contrast can't drift with a chrome retheme.
export const IZ = {
  cyan: '#2299bf',
  violet: '#8467e0',
  gold: '#a8842e',
  green: '#3fa172',
  grid: '#1b2440',
  axis: '#61719b',
  surface: '#0f1526',
  track: '#1c2742',
} as const

// Axis/figure font for every chart. The project ships no webfont, so a
// named face here must resolve locally — hence a real fallback stack.
export const AXIS_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

// ── HitRects — transparent per-point hover/pin bands ────────────────────────

interface HitRectProps {
  x: number
  top: number
  height: number
  bandW: number
  index: number
  setHover: (i: number | null) => void
  togglePin: (i: number) => void
}

/** ONE point's hover/pin band. Exported on its own because paint order is
 *  document order in SVG: the revenue chart interleaves each band with that
 *  point's ring+dot inside a per-point <g> (the shipped order), while the
 *  traffic/device charts paint their bands as one block after the markers.
 *  Both spellings share this single geometry home. */
export function HitRect({ x, top, height, bandW, index, setHover, togglePin }: HitRectProps) {
  return (
    <rect
      x={x - bandW / 2}
      y={top}
      width={bandW}
      height={height}
      fill="transparent"
      style={{ cursor: 'pointer' }}
      onMouseEnter={() => setHover(index)}
      onClick={(e) => { e.stopPropagation(); togglePin(index) }}
    />
  )
}

interface HitRectsProps {
  xs: number[]
  top: number
  height: number
  bandW: number
  setHover: (i: number | null) => void
  togglePin: (i: number) => void
}

export function HitRects({ xs, top, height, bandW, setHover, togglePin }: HitRectsProps) {
  return (
    <>
      {xs.map((x, i) => (
        <HitRect
          key={i}
          x={x}
          top={top}
          height={height}
          bandW={bandW}
          index={i}
          setHover={setHover}
          togglePin={togglePin}
        />
      ))}
    </>
  )
}

// ── Crosshair — dashed vertical line at the active index ────────────────────

export function Crosshair({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  return (
    <line
      x1={x}
      x2={x}
      y1={top}
      y2={bottom}
      style={{ stroke: IZ.axis }}
      strokeDasharray="2 3"
      opacity="0.5"
    />
  )
}

// ── ChartTip — absolutely-positioned tooltip wrapper ────────────────────────
// Anchor comes from chartKit.tooltipAnchor; the wrapper only positions —
// row content stays with the chart that owns the data.

export function ChartTip({ anchor, width, children }: {
  anchor: TooltipAnchor
  width: number
  children: ReactNode
}) {
  return (
    <div
      className={styles.revTip}
      style={{
        position: 'absolute',
        left: anchor.left,
        top: anchor.top,
        transform: anchor.transform,
        width,
      }}
    >
      {children}
    </div>
  )
}

// ── YTicks — horizontal gridlines + right-aligned tick labels ───────────────

interface YTicksProps {
  ticks: number[]
  yScale: (v: number) => number
  x1: number
  x2: number
  labelX: number
  fontSize?: number
  format?: (v: number) => string
}

export function YTicks({ ticks, yScale, x1, x2, labelX, fontSize = 11, format }: YTicksProps) {
  // A tick domain can repeat a value: both integer domains clamp their last
  // tick to maxV, which collides with the previous step whenever the rounded
  // step already reached it (traffic maxV 6 -> [0,2,4,6,6]; device-trend
  // maxV 4 -> [0,2,4,4], and 4 is that chart's hard floor). A repeat renders
  // one gridline and label on top of another AND duplicates the React key, so
  // drop it here — one guard for every chart. First occurrence wins.
  const unique = ticks.filter((t, i) => ticks.indexOf(t) === i)
  return (
    <>
      {unique.map((t) => (
        <g key={t}>
          <line
            x1={x1}
            x2={x2}
            y1={yScale(t)}
            y2={yScale(t)}
            style={{ stroke: IZ.grid }}
            strokeDasharray="3 4"
          />
          <text
            x={labelX}
            y={yScale(t) + 4}
            textAnchor="end"
            fontSize={fontSize}
            style={{ fill: IZ.axis }}
            fontFamily={AXIS_FONT}
          >
            {format ? format(t) : t}
          </text>
        </g>
      ))}
    </>
  )
}

// ── XLabels — bottom axis labels; `show` keeps each chart's cadence rule ────

interface XLabelsProps {
  xs: number[]
  labels: string[]
  y: number
  fontSize: number
  show: (i: number) => boolean
}

export function XLabels({ xs, labels, y, fontSize, show }: XLabelsProps) {
  return (
    <>
      {labels.map((label, i) =>
        show(i) ? (
          <text
            key={i}
            x={xs[i]}
            y={y}
            textAnchor="middle"
            fontSize={fontSize}
            style={{ fill: IZ.axis }}
            fontFamily={AXIS_FONT}
          >
            {label}
          </text>
        ) : null
      )}
    </>
  )
}
