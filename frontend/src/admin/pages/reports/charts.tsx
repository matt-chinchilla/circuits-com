// The Reports page's hand-rolled native SVG charts (replaces Recharts
// ~400KB) — Phase A7 port of the 2026-04-25 Claude Design bundle:
//   - ReportsRevenueChart : stacked area + total trendline, hover tooltip
//   - RevenueDonut        : 2-segment donut + KPI center + legend
//   - HBarChart           : animated horizontal bar list
//   - TrafficChart        : daily views + visitors line chart
//   - DeviceDonut / DeviceTrendChart : device mix + per-type trend
// Shared presentational pieces (hit rects, crosshair, tooltip wrapper,
// axis text) live in chartParts.tsx; the math lives in chartKit.ts.

import { useId, useMemo } from 'react'
import styles from './ReportsPage.module.scss'
import { monotoneAreaPath, monotonePath, tooltipAnchor } from './chartKit'
import { AXIS_FONT, ChartTip, Crosshair, HitRects, IZ, XLabels, YTicks } from './chartParts'
import { useChartActive } from './useChartActive'

const GRAD_CHIP = 'linear-gradient(90deg, #2299bf, #3fa172)'

export interface RevSeriesPoint {
  m: string
  listing: number
  sponsor: number
}

// ─── ReportsRevenueChart (stacked area + trendline + tooltip) ───────────────

interface ReportsRevenueChartProps {
  series: RevSeriesPoint[]
}

// Geometry is pure in `series` and memoized by the chart so hover/pin only
// re-renders the crosshair/dots/tooltip, not the Steffen path computation.
function revenueGeometry(series: RevSeriesPoint[]) {
  const W = 800
  const H = 280
  const PAD_L = 50
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 36
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  // Pick a maxV that always covers the data (next round 2k above the peak).
  const peak = Math.max(...series.map((d) => d.listing + d.sponsor))
  const maxV = Math.max(2000, Math.ceil(peak / 2000) * 2000)
  const N = series.length
  const xs = N === 1
    ? [PAD_L + innerW / 2]
    : series.map((_, i) => PAD_L + (i / (N - 1)) * innerW)
  const yScale = (v: number) => PAD_T + innerH - (v / maxV) * innerH

  const sponsorTop = series.map((d) => d.listing + d.sponsor)

  // Monotone-smoothed bands. The sponsor band's bottom edge retraces the
  // listing curve in reverse (Steffen tangents are direction-symmetric, so
  // the two edges coincide with no sliver gap).
  const listingPts = series.map((d, i) => ({ x: xs[i], y: yScale(d.listing) }))
  const topPts = sponsorTop.map((v, i) => ({ x: xs[i], y: yScale(v) }))
  const listingPath = monotoneAreaPath(listingPts, yScale(0))
  const listingBack = monotonePath([...listingPts].reverse()).replace(/^M/, 'L')
  const sponsorPath = `${monotonePath(topPts)} ${listingBack} Z`
  const totalLine = monotonePath(topPts)

  const tickStep = maxV / 4
  const yTicks = [0, tickStep, tickStep * 2, tickStep * 3, maxV]

  return {
    W, H, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, N,
    xs, yScale, sponsorTop, listingPath, sponsorPath, totalLine, yTicks,
  }
}

export function ReportsRevenueChart({ series }: ReportsRevenueChartProps) {
  const { active, pinned, setHover, togglePin, clearPin } = useChartActive(series)
  const gid = useId().replace(/:/g, '')
  const geo = useMemo(() => revenueGeometry(series), [series])

  if (series.length === 0) {
    return <div className={styles.empty}>No revenue data yet.</div>
  }

  const {
    W, H, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, N,
    xs, yScale, sponsorTop, listingPath, sponsorPath, totalLine, yTicks,
  } = geo

  const tipData = active !== null ? series[active] : null
  const anchor = active !== null
    ? tooltipAnchor(xs[active], yScale(sponsorTop[active]), W, H)
    : null

  return (
    <div className={styles.chartWrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chart}
        onMouseLeave={() => setHover(null)}
        onClick={clearPin}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id={`${gid}-listing`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={IZ.cyan} stopOpacity="0.3" />
            <stop offset="100%" stopColor={IZ.cyan} stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id={`${gid}-sponsor`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={IZ.gold} stopOpacity="0.4" />
            <stop offset="100%" stopColor={IZ.gold} stopOpacity="0.08" />
          </linearGradient>
          <linearGradient
            id={`${gid}-stroke`}
            gradientUnits="userSpaceOnUse"
            x1={PAD_L}
            y1="0"
            x2={W - PAD_R}
            y2="0"
          >
            <stop offset="0%" stopColor={IZ.cyan} />
            <stop offset="100%" stopColor={IZ.green} />
          </linearGradient>
        </defs>
        <YTicks
          ticks={yTicks}
          yScale={yScale}
          x1={PAD_L}
          x2={W - PAD_R}
          labelX={PAD_L - 8}
          format={(t) => t.toLocaleString()}
        />
        <XLabels
          xs={xs}
          labels={series.map((d) => d.m)}
          y={H - PAD_B + 18}
          fontSize={11}
          show={(i) => i % 2 === 0}
        />
        {N >= 2 && (
          <>
            <path d={listingPath} fill={`url(#${gid}-listing)`} className={styles.revArea} />
            <path d={sponsorPath} fill={`url(#${gid}-sponsor)`} className={styles.revArea} />
            <path
              d={totalLine}
              fill="none"
              stroke={`url(#${gid}-stroke)`}
              strokeWidth="2"
              className={styles.revLine}
            />
          </>
        )}
        {active !== null && <Crosshair x={xs[active]} top={PAD_T} bottom={H - PAD_B} />}
        {N >= 2 && (
          <HitRects
            xs={xs}
            top={PAD_T}
            height={innerH}
            bandW={innerW / N}
            setHover={setHover}
            togglePin={togglePin}
          />
        )}
        {series.map((d, i) => (
          <g key={d.m}>
            {pinned === i && (
              <circle
                cx={xs[i]}
                cy={yScale(sponsorTop[i])}
                r={8}
                fill="none"
                style={{ stroke: IZ.cyan }}
                strokeWidth="1.5"
                opacity="0.5"
              />
            )}
            <circle
              cx={xs[i]}
              cy={yScale(sponsorTop[i])}
              r={active === i || N === 1 ? 5 : 3}
              style={{ fill: IZ.cyan, stroke: IZ.surface }}
              strokeWidth="2"
            />
            {N === 1 && (
              <text x={xs[i] + 10} y={yScale(sponsorTop[i]) - 8} fontSize="11" style={{ fill: IZ.cyan }} fontWeight="600">
                {`$${sponsorTop[i].toLocaleString()} total`}
              </text>
            )}
          </g>
        ))}
      </svg>
      {tipData && anchor && (
        <ChartTip anchor={anchor} width={160}>
          <div className={styles.revTipTitle}>{tipData.m}</div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: IZ.gold }} />
            Sponsor<b>${tipData.sponsor.toLocaleString()}</b>
          </div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: IZ.cyan }} />
            Listings<b>${tipData.listing.toLocaleString()}</b>
          </div>
          <div className={styles.revTipTotal}>
            Total <b>${(tipData.listing + tipData.sponsor).toLocaleString()}</b>
          </div>
        </ChartTip>
      )}
      <div className={styles.chartLegend}>
        <span>
          <i className="dot" style={{ background: IZ.gold }} />
          Sponsorship
        </span>
        <span>
          <i className="dot" style={{ background: IZ.cyan }} />
          Listing fees
        </span>
        <span>
          <i className="dash" style={{ background: GRAD_CHIP }} />
          Total revenue
        </span>
      </div>
    </div>
  )
}

// ─── RevenueDonut ───────────────────────────────────────────────────────────

interface RevenueDonutProps {
  sponsor: number
  listing: number
}

export function RevenueDonut({ sponsor, listing }: RevenueDonutProps) {
  const total = sponsor + listing
  const sPct = total > 0 ? sponsor / total : 0
  const lPct = total > 0 ? listing / total : 0
  const C = 2 * Math.PI * 60
  const sLen = C * sPct
  const lLen = C * lPct

  return (
    <div className={styles.donutWrap}>
      <svg viewBox="0 0 200 200" className={styles.donut}>
        <circle cx="100" cy="100" r="60" fill="none" style={{ stroke: IZ.track }} strokeWidth="22" />
        <g transform="rotate(-90 100 100)">
          <circle
            cx="100"
            cy="100"
            r="60"
            fill="none"
            stroke={IZ.gold}
            strokeWidth="22"
            strokeDasharray={`${Math.max(0, sLen - 3)} ${C - Math.max(0, sLen - 3)}`}
            strokeLinecap="round"
            className={`${styles.donutArc} ${styles.sArc}`}
          />
          <circle
            cx="100"
            cy="100"
            r="60"
            fill="none"
            style={{ stroke: IZ.cyan }}
            strokeWidth="22"
            strokeDasharray={`${Math.max(0, lLen - 3)} ${C - Math.max(0, lLen - 3)}`}
            strokeDashoffset={-sLen}
            strokeLinecap="round"
            className={`${styles.donutArc} ${styles.lArc}`}
          />
        </g>
        <text x="100" y="92" textAnchor="middle" fontSize="13" style={{ fill: IZ.axis }}>
          Total YTD
        </text>
        <text
          x="100"
          y="116"
          textAnchor="middle"
          fontSize="22"
          fontWeight="700"
          style={{ fill: '#e8eef9' }}
          fontFamily={AXIS_FONT}
        >
          ${(total / 1000).toFixed(1)}k
        </text>
      </svg>
      <div className={styles.donutLegend}>
        <div className={styles.donutRow}>
          <span className="dot" style={{ background: IZ.gold }} />
          <span>sponsorship</span>
          <span className="pct">{Math.round(sPct * 100)}%</span>
        </div>
        <div className={styles.donutRow}>
          <span className="dot" style={{ background: IZ.cyan }} />
          <span>listing_fee</span>
          <span className="pct">{Math.round(lPct * 100)}%</span>
        </div>
      </div>
    </div>
  )
}

// ─── HBarChart ──────────────────────────────────────────────────────────────

interface HBarChartProps {
  data: Array<[string, number]>
  max: number
  fmt?: (v: number) => string
  color?: string
}

export function HBarChart({ data, max, fmt = (v: number) => `${v}`, color = IZ.cyan }: HBarChartProps) {
  if (data.length === 0) {
    return <div className={styles.empty}>No data.</div>
  }
  return (
    <div className={styles.hbarList}>
      {data.map(([label, v], i) => (
        <div className={styles.hbarRow} key={label}>
          <div className={styles.hbarLabel} title={label}>
            {label}
          </div>
          <div className={styles.hbarTrack}>
            <div
              className={styles.hbarFill}
              style={{
                width: `${Math.min(100, (v / max) * 100)}%`,
                background: `linear-gradient(90deg, color-mix(in srgb, ${color} 45%, #0f1526), ${color})`,
                animationDelay: `${i * 70}ms`,
              }}
            />
          </div>
          <div className={styles.hbarVal}>{fmt(v)}</div>
        </div>
      ))}
    </div>
  )
}

// ─── TrafficChart (daily views + visitors line chart) ───────────────────────

interface TrafficChartProps {
  data: Array<{ day: string; views: number; visitors: number }>
}

// Memoized geometry — see revenueGeometry. At N=365 this is the chart where
// hover-driven Steffen recomputation actually cost something.
function trafficGeometry(data: TrafficChartProps['data']) {
  const W = 800
  const H = 240
  const PAD = { l: 50, r: 16, t: 16, b: 36 }
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const maxV = Math.max(4, ...data.map(d => d.views))
  const N = data.length
  const xs = N === 1
    ? [PAD.l + innerW / 2]
    : data.map((_, i) => PAD.l + (i / (N - 1)) * innerW)
  const yScale = (v: number) => PAD.t + innerH - (v / maxV) * innerH

  const tickStep = Math.max(1, Math.ceil(maxV / 4))
  const yTicks = [0, tickStep, tickStep * 2, tickStep * 3, Math.min(tickStep * 4, maxV)]
  const labelEvery = Math.max(1, Math.floor(N / 7))

  // Monotone (Steffen) smoothing — never overshoots a data point.
  const viewsPts = data.map((d, i) => ({ x: xs[i], y: yScale(d.views) }))
  const visitorsPts = data.map((d, i) => ({ x: xs[i], y: yScale(d.visitors) }))
  const viewsLine = N >= 2 ? monotonePath(viewsPts) : ''
  const visitorsLine = N >= 2 ? monotonePath(visitorsPts) : ''
  const viewsArea = N >= 2 ? monotoneAreaPath(viewsPts, yScale(0)) : ''

  return { W, H, PAD, innerW, innerH, N, xs, yScale, yTicks, labelEvery, viewsLine, visitorsLine, viewsArea }
}

export function TrafficChart({ data }: TrafficChartProps) {
  const { active, pinned, setHover, togglePin, clearPin } = useChartActive(data)
  const gid = useId().replace(/:/g, '')
  const geo = useMemo(() => trafficGeometry(data), [data])

  if (data.length === 0) {
    return <div className={styles.empty}>No traffic data yet.</div>
  }

  const { W, H, PAD, innerW, innerH, N, xs, yScale, yTicks, labelEvery, viewsLine, visitorsLine, viewsArea } = geo

  // Pinned beats hover; both drive one tooltip anchored ABOVE the dot.
  const shown = active !== null ? data[active] : null
  const anchor = active !== null
    ? tooltipAnchor(xs[active], yScale(data[active].views), W, H)
    : null

  return (
    <div className={styles.chartWrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chart}
        onMouseLeave={() => setHover(null)}
        onClick={clearPin}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id={`${gid}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={IZ.cyan} stopOpacity="0.26" />
            <stop offset="100%" stopColor={IZ.cyan} stopOpacity="0" />
          </linearGradient>
          <linearGradient
            id={`${gid}-stroke`}
            gradientUnits="userSpaceOnUse"
            x1={PAD.l}
            y1="0"
            x2={W - PAD.r}
            y2="0"
          >
            <stop offset="0%" stopColor={IZ.cyan} />
            <stop offset="100%" stopColor={IZ.green} />
          </linearGradient>
        </defs>
        <YTicks ticks={yTicks} yScale={yScale} x1={PAD.l} x2={W - PAD.r} labelX={PAD.l - 8} />
        <XLabels
          xs={xs}
          labels={data.map(d => d.day.slice(5))}
          y={H - PAD.b + 18}
          fontSize={10}
          show={i => i % labelEvery === 0 || N <= 3}
        />
        {N >= 2 && (
          <>
            <path d={viewsArea} fill={`url(#${gid}-area)`} className={styles.revArea} />
            <path d={viewsLine} fill="none" stroke={`url(#${gid}-stroke)`} strokeWidth="2" className={styles.revLine} />
            <path d={visitorsLine} fill="none" stroke={IZ.violet} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.75" />
          </>
        )}
        {data.map((d, i) => {
          // Dot density: on long ranges a dot per day reads as noise, not
          // data (the smoothed line carries the shape). Resting dots render
          // only when the series is sparse; the active/pinned index always
          // gets its markers via the crosshair block below.
          const showRestingDot = N <= 45 || active === i
          if (!showRestingDot && N !== 1) return null
          return (
            <g key={d.day}>
              {pinned === i && (
                <circle cx={xs[i]} cy={yScale(d.views)} r={8} fill="none" style={{ stroke: IZ.cyan }} strokeWidth="1.5" opacity="0.5" />
              )}
              <circle cx={xs[i]} cy={yScale(d.views)} r={active === i || N === 1 ? 5 : 3} style={{ fill: IZ.cyan, stroke: IZ.surface }} strokeWidth="2" />
              <circle cx={xs[i]} cy={yScale(d.visitors)} r={active === i || N === 1 ? 4 : 2.5} fill={IZ.violet} style={{ stroke: IZ.surface }} strokeWidth="1.5" />
              {N === 1 && (
                <>
                  <text x={xs[i] + 10} y={yScale(d.views) - 8} fontSize="11" style={{ fill: IZ.cyan }} fontWeight="600">{d.views} views</text>
                  <text x={xs[i] + 10} y={yScale(d.visitors) + 16} fontSize="11" fill={IZ.violet} fontWeight="600">{d.visitors} visitors</text>
                </>
              )}
            </g>
          )
        })}
        {active !== null && N >= 2 && <Crosshair x={xs[active]} top={PAD.t} bottom={H - PAD.b} />}
        {N >= 2 && (
          <HitRects
            xs={xs}
            top={PAD.t}
            height={innerH}
            bandW={innerW / N}
            setHover={setHover}
            togglePin={togglePin}
          />
        )}
      </svg>
      {shown && anchor && (
        <ChartTip anchor={anchor} width={140}>
          <div className={styles.revTipTitle}>{shown.day}</div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: IZ.cyan }} />Views<b>{shown.views}</b>
          </div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: IZ.violet }} />Visitors<b>{shown.visitors}</b>
          </div>
        </ChartTip>
      )}
      <div className={styles.chartLegend}>
        <span><i className="dot" style={{ background: GRAD_CHIP }} />Page Views</span>
        <span><i className="dash" style={{ background: IZ.violet }} />Unique Visitors</span>
      </div>
    </div>
  )
}

// ─── DeviceDonut ────────────────────────────────────────────────────────────

const DEVICE_COLORS: Record<string, string> = {
  desktop: IZ.cyan,
  mobile: IZ.violet,
  tablet: IZ.gold,
  unknown: IZ.axis,
}

interface DeviceDonutProps {
  data: Array<{ type: string; count: number }>
}

export function DeviceDonut({ data }: DeviceDonutProps) {
  const total = data.reduce((s, d) => s + d.count, 0)
  const R = 54
  const C = 2 * Math.PI * R

  // Pre-compute arc lengths and cumulative offsets to avoid mutation inside JSX
  const arcs = data.map(d => (total > 0 ? (d.count / total) * C : 0))
  const offsets: number[] = []
  let cumulative = 0
  for (const len of arcs) {
    offsets.push(cumulative)
    cumulative += len
  }

  return (
    <div className={styles.deviceGrid}>
      <svg viewBox="0 0 140 140" width="140" height="140">
        <circle cx="70" cy="70" r={R} fill="none" style={{ stroke: IZ.track }} strokeWidth="14" />
        {data.map((d, i) => (
          <circle
            key={i}
            cx="70" cy="70" r={R}
            fill="none"
            strokeWidth="14"
            strokeDasharray={`${Math.max(0, arcs[i] - 3)} ${C - Math.max(0, arcs[i] - 3)}`}
            strokeDashoffset={-offsets[i]}
            strokeLinecap="butt"
            className={styles.donutArc}
            style={{ animationDelay: `${i * 120}ms`, stroke: DEVICE_COLORS[d.type] ?? IZ.axis }}
          />
        ))}
        <text x="70" y="66" textAnchor="middle" fontSize="11" style={{ fill: IZ.axis }}>Total</text>
        <text x="70" y="84" textAnchor="middle" fontSize="18" fontWeight="700" style={{ fill: '#e8eef9' }}>{total}</text>
      </svg>
      <div className={styles.deviceLegend}>
        {data.map(d => (
          <div key={d.type} className={styles.deviceRow}>
            <span className={styles.deviceSwatch} style={{ background: DEVICE_COLORS[d.type] ?? IZ.axis }} />
            <span>{d.type}</span>
            <span className={styles.deviceVal}>{total > 0 ? Math.round((d.count / total) * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── DeviceTrendChart (multi-line: desktop/mobile/tablet over time) ─────────

const DEVICE_LINES: Array<{ key: 'desktop' | 'mobile' | 'tablet'; color: string; label: string }> = [
  { key: 'desktop', color: IZ.cyan, label: 'Desktop' },
  { key: 'mobile', color: IZ.violet, label: 'Mobile' },
  { key: 'tablet', color: IZ.gold, label: 'Tablet' },
]

interface DeviceTrendPoint {
  day: string
  desktop: number
  mobile: number
  tablet: number
}

// Memoized geometry — see revenueGeometry.
function deviceTrendGeometry(data: DeviceTrendPoint[]) {
  const W = 800, H = 200
  const PAD = { l: 40, r: 16, t: 12, b: 32 }
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const maxV = Math.max(4, ...data.flatMap(d => [d.desktop, d.mobile, d.tablet]))
  const N = data.length
  const xs = N === 1
    ? [PAD.l + innerW / 2]
    : data.map((_, i) => PAD.l + (i / (N - 1)) * innerW)
  const yScale = (v: number) => PAD.t + innerH - (v / maxV) * innerH

  const tickStep = Math.max(1, Math.ceil(maxV / 3))
  const yTicks = [0, tickStep, tickStep * 2, Math.min(tickStep * 3, maxV)]
  const labelEvery = Math.max(1, Math.floor(N / 7))

  const lines = N >= 2
    ? DEVICE_LINES.map(({ key, color }) => ({
        key,
        color,
        d: monotonePath(data.map((p, i) => ({ x: xs[i], y: yScale(p[key]) }))),
      }))
    : []

  return { W, H, PAD, innerW, innerH, N, xs, yScale, yTicks, labelEvery, lines }
}

export function DeviceTrendChart({ data }: { data: DeviceTrendPoint[] }) {
  const { active, pinned, setHover, togglePin, clearPin } = useChartActive(data)
  const geo = useMemo(() => deviceTrendGeometry(data), [data])

  if (data.length === 0) {
    return <div className={styles.empty}>No device trend data yet.</div>
  }

  const { W, H, PAD, innerW, innerH, N, xs, yScale, yTicks, labelEvery, lines } = geo

  const shown = active !== null ? data[active] : null
  // Anchor above the TOPMOST series dot so the tip never covers a line.
  const anchor = active !== null
    ? tooltipAnchor(
        xs[active],
        Math.min(...DEVICE_LINES.map(({ key }) => yScale(data[active][key]))),
        W,
        H,
      )
    : null

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} onMouseLeave={() => setHover(null)} onClick={clearPin} preserveAspectRatio="xMidYMid meet" style={{ height: 200 }}>
        <YTicks ticks={yTicks} yScale={yScale} x1={PAD.l} x2={W - PAD.r} labelX={PAD.l - 6} fontSize={10} />
        <XLabels
          xs={xs}
          labels={data.map(d => d.day.slice(5))}
          y={H - PAD.b + 16}
          fontSize={9}
          show={i => i % labelEvery === 0 || N <= 3}
        />
        {lines.map(({ key, color, d }) => (
          <path key={key} d={d} fill="none" style={{ stroke: color }} strokeWidth="1.8" opacity="0.85" />
        ))}
        {N === 1 && DEVICE_LINES.map(({ key, color }) => (
          <circle key={key} cx={xs[0]} cy={yScale(data[0][key])} r={4} style={{ fill: color, stroke: IZ.surface }} strokeWidth="1.5" />
        ))}
        {active !== null && N >= 2 && (
          <g>
            <Crosshair x={xs[active]} top={PAD.t} bottom={H - PAD.b} />
            {DEVICE_LINES.map(({ key, color }) => (
              <circle key={key} cx={xs[active]} cy={yScale(data[active][key])} r={pinned === active ? 4.5 : 3.5} style={{ fill: color, stroke: IZ.surface }} strokeWidth="1.5" />
            ))}
          </g>
        )}
        {N >= 2 && (
          <HitRects
            xs={xs}
            top={PAD.t}
            height={innerH}
            bandW={innerW / N}
            setHover={setHover}
            togglePin={togglePin}
          />
        )}
      </svg>
      {shown && anchor && (
        <ChartTip anchor={anchor} width={130}>
          <div className={styles.revTipTitle}>{shown.day}</div>
          {DEVICE_LINES.map(({ key, color, label }) => (
            <div key={key} className={styles.revTipRow}><span className="dot" style={{ background: color }} />{label}<b>{shown[key]}</b></div>
          ))}
        </ChartTip>
      )}
      <div className={styles.chartLegend}>
        {DEVICE_LINES.map(({ key, color, label }) => (
          <span key={key}><i className="dot" style={{ background: color }} />{label}</span>
        ))}
      </div>
    </div>
  )
}
