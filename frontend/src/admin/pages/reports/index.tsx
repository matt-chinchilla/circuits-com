import { useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Download } from 'lucide-react'
import { useDemo } from '@admin/contexts/DemoContext'
import { adminApi } from '@admin/services/adminApi'
import type {
  AnalyticsData,
  AnalyticsSegment,
  DashboardStats,
  RevenueDataPoint,
  PopularData,
} from '@admin/types/admin'
import styles from './ReportsPage.module.scss'
import WorldMapPanel from './WorldMapPanel'
import { monotoneAreaPath, monotonePath, refHost, tooltipAnchor } from './chartKit'
import { AXIS_FONT, ChartTip, Crosshair, HitRects, IZ, XLabels, YTicks } from './chartParts'
import { useChartActive } from './useChartActive'

const GRAD_CHIP = 'linear-gradient(90deg, #2299bf, #3fa172)'


// ReportsPage — Phase A7 port of the 2026-04-25 Claude Design bundle.
// Hand-rolled native SVG charts (replaces Recharts ~400KB).
// Charts are inline components in this file:
//   - ReportsRevenueChart : stacked area + total trendline, hover tooltip
//   - RevenueDonut        : 2-segment donut + KPI center + legend
//   - HBarChart           : animated horizontal bar list

// ─── Demo data (bundle's hand-tuned 12-month series) ────────────────────────

interface RevSeriesPoint {
  m: string
  listing: number
  sponsor: number
}

const DEMO_REV_SERIES: RevSeriesPoint[] = [
  { m: '2025-04', listing: 320, sponsor: 1500 },
  { m: '2025-05', listing: 410, sponsor: 1500 },
  { m: '2025-06', listing: 480, sponsor: 2250 },
  { m: '2025-07', listing: 520, sponsor: 2250 },
  { m: '2025-08', listing: 610, sponsor: 3000 },
  { m: '2025-09', listing: 720, sponsor: 4500 },
  { m: '2025-10', listing: 840, sponsor: 4500 },
  { m: '2025-11', listing: 910, sponsor: 5500 },
  { m: '2025-12', listing: 980, sponsor: 5500 },
  { m: '2026-01', listing: 1040, sponsor: 6000 },
  { m: '2026-02', listing: 1120, sponsor: 6500 },
  { m: '2026-03', listing: 1180, sponsor: 7000 },
]

const DEMO_PARTS_BY_CAT: Array<[string, number]> = [
  ['Sensor ICs', 14],
  ['Interface ICs', 12],
  ['Power Management ICs (PMICs)', 11],
  ['Microcontrollers & Processors', 10],
  ['Audio & Video ICs', 9],
  ['Memory ICs', 8],
  ['Logic ICs', 7],
  ['Analog ICs', 6],
]

const DEMO_TOP_SUPPLIERS: Array<[string, number]> = [
  ['Future Electronics', 32],
  ['Arrow Electronics', 28],
  ['Mouser Electronics', 24],
  ['Avnet', 20],
  ['Digi-Key Electronics', 18],
  ['Kennedy Electronics', 14],
  ['Honeywell Sensing', 10],
  ['TTI', 8],
]

const DEMO_REPORTS = [
  {
    name: 'Monthly revenue summary',
    desc: 'Sponsorship + listing fees by tier',
    updated: '2026-04-22',
    size: '12 KB',
    format: 'PDF' as const,
  },
  {
    name: 'Catalog freshness',
    desc: 'Parts not synced in >30 days',
    updated: '2026-04-23',
    size: '4.2 MB',
    format: 'CSV' as const,
  },
  {
    name: 'Supplier health',
    desc: 'Authorized status, sync cadence, error rate',
    updated: '2026-04-24',
    size: '88 KB',
    format: 'XLSX' as const,
  },
  {
    name: 'Top searched parts',
    desc: 'Search volume vs in-stock availability',
    updated: '2026-04-24',
    size: '210 KB',
    format: 'CSV' as const,
  },
  {
    name: 'Sponsor performance',
    desc: 'Impressions, click-thru by tier',
    updated: '2026-04-22',
    size: '64 KB',
    format: 'PDF' as const,
  },
  {
    name: 'NRND / Obsolete drift',
    desc: 'Parts whose status changed this week',
    updated: '2026-04-21',
    size: '32 KB',
    format: 'CSV' as const,
  },
]

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

function ReportsRevenueChart({ series }: ReportsRevenueChartProps) {
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

function RevenueDonut({ sponsor, listing }: RevenueDonutProps) {
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

function HBarChart({ data, max, fmt = (v: number) => `${v}`, color = IZ.cyan }: HBarChartProps) {
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

function TrafficChart({ data }: TrafficChartProps) {
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

function DeviceDonut({ data }: DeviceDonutProps) {
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

function DeviceTrendChart({ data }: { data: DeviceTrendPoint[] }) {
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

// ─── Page ───────────────────────────────────────────────────────────────────

// 'All' removed 2026-08-21: the server caps days at 365, so it silently
// duplicated 12m — a range button must not promise more than it fetches.
type RangeKey = '30d' | '90d' | '12m'
type TabKey = 'analytics' | 'exports' | 'site'

const RANGE_DAYS: Record<RangeKey, number> = { '30d': 30, '90d': 90, '12m': 365 }

interface KpiProps {
  label: string
  value: ReactNode
  delta: ReactNode
  tone?: 'up' | 'down' | 'neutral'
  valueStyle?: CSSProperties
}

function Kpi({ label, value, delta, tone = 'neutral', valueStyle }: KpiProps) {
  return (
    <div className={styles.repKpi}>
      <div className={styles.repKpiLabel}>{label}</div>
      <div className={styles.repKpiVal} style={valueStyle}>{value}</div>
      <div className={`${styles.repKpiDelta} ${styles[tone]}`}>{delta}</div>
    </div>
  )
}

export default function ReportsPage() {
  const { demoMode } = useDemo()
  const [range, setRange] = useState<RangeKey>('12m')
  const [tab, setTab] = useState<TabKey>('analytics')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([])
  const [popular, setPopular] = useState<PopularData | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [segment, setSegment] = useState<AnalyticsSegment>('humans')
  const [segmentError, setSegmentError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([adminApi.getStats(), adminApi.getRevenue(), adminApi.getPopular()])
      .then(([s, r, p]) => {
        if (cancelled) return
        setStats(s)
        setRevenue(r)
        setPopular(p)
        setError('')
      })
      .catch(() => { if (!cancelled) setError('Failed to load report data.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [demoMode])

  useEffect(() => {
    let cancelled = false
    adminApi.getAnalytics(RANGE_DAYS[range], segment)
      .then(a => {
        if (cancelled) return
        setAnalytics(a)
        setSegmentError(false)
      })
      .catch(() => {
        // The toggle already flipped but the data did not — captions must
        // keep describing the DATA (analytics.segment), and the failure is
        // said out loud instead of silently mislabeling human numbers.
        if (!cancelled) setSegmentError(true)
      })
    return () => { cancelled = true }
    // segment is part of the query — the charts' pinned tooltips clear
    // automatically because the data identity changes.
  }, [demoMode, range, segment])

  // The segment the RENDERED data actually represents (response-carried);
  // falls back to the requested one before first load.
  const shownSegment: AnalyticsSegment = analytics?.segment ?? segment

  // Build the chart series — bundle's hand-tuned data in demo mode, otherwise
  // map the API's RevenueDataPoint[] to the {m, listing, sponsor} shape.
  const revSeries: RevSeriesPoint[] = useMemo(() => {
    if (demoMode) return DEMO_REV_SERIES
    return revenue.map((r) => ({
      m: r.month,
      listing: r.listing_fee + r.featured,
      sponsor: r.sponsorship,
    }))
  }, [demoMode, revenue])

  const partsByCat: Array<[string, number]> = useMemo(() => {
    if (demoMode) return DEMO_PARTS_BY_CAT
    return (popular?.top_categories ?? [])
      .slice(0, 8)
      .map((c) => [c.name, c.parts_count] as [string, number])
  }, [demoMode, popular])

  const topSuppliers: Array<[string, number]> = useMemo(() => {
    if (demoMode) return DEMO_TOP_SUPPLIERS
    return (popular?.top_suppliers ?? [])
      .slice(0, 8)
      .map((s) => [s.name, s.listings_count] as [string, number])
  }, [demoMode, popular])

  // KPI computations
  const ytd = revSeries.reduce((n, d) => n + d.listing + d.sponsor, 0)
  const last = revSeries.length > 0 ? revSeries[revSeries.length - 1] : null
  const prev = revSeries.length > 1 ? revSeries[revSeries.length - 2] : null
  const lastTotal = last ? last.listing + last.sponsor : 0
  const prevTotal = prev ? prev.listing + prev.sponsor : 0
  const mom = prevTotal > 0 ? ((lastTotal - prevTotal) / prevTotal) * 100 : 0

  const totalSponsorYtd = revSeries.reduce((n, d) => n + d.sponsor, 0)
  const totalListingYtd = revSeries.reduce((n, d) => n + d.listing, 0)

  const sponsorsActive = demoMode ? 12 : (stats?.sponsors_count ?? 0)
  const partsIndexed = demoMode ? 2_487_302 : (stats?.parts_count ?? 0)
  const suppliersActive = demoMode ? 186 : (stats?.suppliers_count ?? 0)

  const partsByCatMax = Math.max(16, ...partsByCat.map(([, v]) => v))
  const topSuppliersMax = Math.max(32, ...topSuppliers.map(([, v]) => v))

  // Referrer URLs fold to hostnames (google.com/ and google.com/search are
  // one source) — aggregate before charting or the labels collide.
  const refRows: Array<[string, number]> = useMemo(() => {
    const agg = new Map<string, number>()
    for (const r of analytics?.referrers ?? []) {
      const host = refHost(r.source)
      agg.set(host, (agg.get(host) ?? 0) + r.views)
    }
    return [...agg.entries()].sort((a, b) => b[1] - a[1])
  }, [analytics])

  if (loading) {
    return <div className={styles.loading}>Loading reports…</div>
  }

  return (
    <div>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Reports</h1>
          <p>Revenue and parts analytics for the past 12 months.</p>
        </div>
        <div className={styles.pageHeadActions}>
          <div className={styles.seg}>
            {(['30d', '90d', '12m'] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`${styles.segBtn} ${range === r ? styles.on : ''}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`}>
            <Download size={15} strokeWidth={2} />
            Export PDF
          </button>
        </div>
      </div>

      <div className={styles.reportTabs}>
        <button
          type="button"
          className={`${styles.rtTab} ${tab === 'analytics' ? styles.on : ''}`}
          onClick={() => setTab('analytics')}
        >
          Analytics
        </button>
        <button
          type="button"
          className={`${styles.rtTab} ${tab === 'exports' ? styles.on : ''}`}
          onClick={() => setTab('exports')}
        >
          Exports &amp; Saved Reports
        </button>
        <button
          type="button"
          className={`${styles.rtTab} ${tab === 'site' ? styles.on : ''}`}
          onClick={() => setTab('site')}
        >
          Site Analytics
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'analytics' && (
        <>
          <div className={styles.repKpiRow}>
            <Kpi
              label="YTD revenue"
              value={`$${ytd.toLocaleString()}`}
              tone={mom >= 0 ? 'up' : 'down'}
              delta={`${mom >= 0 ? '▲' : '▼'} ${Math.abs(mom).toFixed(1)}% vs last month`}
            />
            <Kpi
              label="Active sponsors"
              value={sponsorsActive}
              tone="up"
              delta={'▲ 2 new this quarter'}
            />
            <Kpi
              label="Parts indexed"
              value={partsIndexed.toLocaleString()}
              tone="up"
              delta={'▲ 1.2% wk/wk'}
            />
            <Kpi label="Suppliers active" value={suppliersActive} delta={'→ steady'} />
          </div>

          <div className={styles.chartsGrid}>
            <div className={`${styles.chartCard} ${styles.chartFull}`}>
              <div className={styles.chartHead}>
                <h3 className={styles.chartTitle}>Revenue Over Time</h3>
                <span className={styles.chartSub}>
                  Stacked: Listing Fee + Sponsorship · Total trendline
                </span>
              </div>
              <ReportsRevenueChart series={revSeries} />
            </div>

            <div className={styles.chartCard}>
              <div className={styles.chartHead}>
                <h3 className={styles.chartTitle}>Revenue by Type</h3>
                <span className={styles.chartSub}>YTD breakdown</span>
              </div>
              <RevenueDonut sponsor={totalSponsorYtd} listing={totalListingYtd} />
            </div>

            <div className={styles.chartCard}>
              <div className={styles.chartHead}>
                <h3 className={styles.chartTitle}>Parts by Category</h3>
                <span className={styles.chartSub}>
                  Top 8 by indexed listings (thousands)
                </span>
              </div>
              <HBarChart
                data={partsByCat}
                max={partsByCatMax}
                fmt={(v) => `${v}k`}
              />
            </div>

            <div className={`${styles.chartCard} ${styles.chartFull}`}>
              <div className={styles.chartHead}>
                <h3 className={styles.chartTitle}>Top Suppliers by Listings</h3>
                <span className={styles.chartSub}>Active SKUs (thousands) · top 8</span>
              </div>
              <HBarChart
                data={topSuppliers}
                max={topSuppliersMax}
                fmt={(v) => `${v}k`}
                color={IZ.gold}
              />
            </div>
          </div>
        </>
      )}

      {tab === 'exports' && (
        <div className={styles.reportsGrid}>
          {DEMO_REPORTS.map((r) => (
            <div key={r.name} className={styles.reportCard}>
              <div className={styles.reportHead}>
                <h3>{r.name}</h3>
                <span
                  className={`${styles.fmt} ${
                    r.format === 'PDF'
                      ? styles.fmtPdf
                      : r.format === 'CSV'
                      ? styles.fmtCsv
                      : styles.fmtXlsx
                  }`}
                >
                  {r.format}
                </span>
              </div>
              <p className={styles.reportDesc}>{r.desc}</p>
              <div className={styles.reportFoot}>
                <span className={styles.reportMeta}>
                  Updated {r.updated} · {r.size}
                </span>
                <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`}>
                  <Download size={13} strokeWidth={2} />
                  Download
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'site' && (
        <>
          <div className={styles.segmentBar}>
            <div className={styles.seg} role="group" aria-label="Traffic segment">
              {(['humans', 'bots', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`${styles.segBtn} ${segment === s ? styles.on : ''}`}
                  aria-pressed={segment === s}
                  onClick={() => setSegment(s)}
                >
                  {s === 'humans' ? 'Humans' : s === 'bots' ? 'Bots' : 'All'}
                  {analytics && (
                    <span className={styles.segCount}>
                      {(s === 'humans'
                        ? analytics.human_views
                        : s === 'bots'
                          ? analytics.bot_views
                          : analytics.human_views + analytics.bot_views
                      ).toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <span className={styles.segmentNote}>
              {segmentError
                ? `Couldn’t load that view — still showing ${shownSegment === 'humans' ? 'human' : shownSegment === 'bots' ? 'crawler' : 'all'} traffic.`
                : shownSegment === 'humans'
                  ? 'Crawlers are filtered out — these numbers are people.'
                  : shownSegment === 'bots'
                    ? 'Crawler and bot traffic only.'
                    : 'Everything the tracker recorded, crawlers included.'}
            </span>
          </div>

          {!analytics || analytics.human_views + analytics.bot_views === 0 ? (
            <div className={styles.analyticsEmpty}>
              <strong>No analytics data yet</strong>
              <p>Page views are tracked automatically. Visit the public site to start collecting data.</p>
            </div>
          ) : (
            <>
              <div className={styles.repKpiRow}>
                <Kpi
                  label="Unique visitors"
                  value={analytics.unique_visitors.toLocaleString()}
                  delta={`last ${analytics.period_days}d`}
                />
                <Kpi
                  label="Page views"
                  value={analytics.total_views.toLocaleString()}
                  delta={`last ${analytics.period_days}d`}
                />
                <Kpi label="Pages / visit" value={analytics.avg_pages_per_visit} delta="average" />
                <Kpi
                  label="Top page"
                  value={analytics.top_pages[0]?.path ?? '—'}
                  valueStyle={{ fontSize: 16 }}
                  delta={`${analytics.top_pages[0]?.views ?? 0} views`}
                />
              </div>

              <div className={styles.chartsGrid}>
                <WorldMapPanel
                  countries={analytics.countries}
                  geoTrackedSince={analytics.geo_tracked_since}
                  segment={analytics.segment}
                />

                <div className={`${styles.chartCard} ${styles.chartFull}`}>
                  <div className={styles.chartHead}>
                    <h3 className={styles.chartTitle}>Traffic Over Time</h3>
                    <span className={styles.chartSub}>Daily page views &amp; unique visitors</span>
                  </div>
                  <TrafficChart data={analytics.daily_traffic} />
                </div>

                <div className={styles.chartCard}>
                  <div className={styles.chartHead}>
                    <h3 className={styles.chartTitle}>Top Pages</h3>
                    <span className={styles.chartSub}>By views · last {analytics.period_days}d</span>
                  </div>
                  <div className={styles.tableScroll}>
                    <table className={styles.topPagesTable}>
                      <thead>
                        <tr><th>Page</th><th style={{ textAlign: 'right' }}>Views</th><th style={{ textAlign: 'right' }}>Visitors</th></tr>
                      </thead>
                      <tbody>
                        {analytics.top_pages.slice(0, 10).map(p => (
                          <tr key={p.path}>
                            <td className={styles.pathCell} title={p.path}>{p.path}</td>
                            <td className={styles.numCell}>{p.views}</td>
                            <td className={styles.numCell}>{p.visitors}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className={styles.chartCard}>
                  <div className={styles.chartHead}>
                    <h3 className={styles.chartTitle}>Devices</h3>
                    <span className={styles.chartSub}>Breakdown by type</span>
                  </div>
                  <DeviceDonut data={analytics.devices} />
                  {analytics.daily_devices.length > 0 && (
                    <>
                      <div className={styles.chartHead} style={{ marginTop: 16 }}>
                        <h3 className={styles.chartTitle}>Device Trend</h3>
                        <span className={styles.chartSub}>Over time</span>
                      </div>
                      <DeviceTrendChart data={analytics.daily_devices} />
                    </>
                  )}
                </div>

                {analytics.crawlers.length > 0 && (
                  <div className={styles.chartCard}>
                    <div className={styles.chartHead}>
                      <h3 className={styles.chartTitle}>AI &amp; Search Crawlers</h3>
                      <span className={styles.chartSub}>
                        Who is indexing the catalog · last {analytics.period_days}d
                      </span>
                    </div>
                    <div className={styles.crawlerList}>
                      {analytics.crawlers.map(c => (
                        <div key={c.family} className={styles.crawlerRow}>
                          <span className={styles.crawlerName}>{c.family}</span>
                          <span className={styles.crawlerTrack}>
                            <span
                              className={styles.crawlerFill}
                              style={{
                                width: `${Math.max(3, (c.views / Math.max(1, analytics.crawlers[0].views)) * 100)}%`,
                              }}
                            />
                          </span>
                          <span className={styles.crawlerViews}>{c.views.toLocaleString()}</span>
                          <span className={styles.crawlerSeen}>
                            {c.last_seen ? c.last_seen.slice(0, 10) : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className={styles.crawlerNote}>
                      Being crawled by AI and search engines makes the catalog findable —
                      it just isn&rsquo;t visitors. These rows are excluded from the
                      Humans segment.
                    </p>
                  </div>
                )}

                {analytics.referrers.length > 0 && (
                  <div className={`${styles.chartCard} ${styles.chartFull}`}>
                    <div className={styles.chartHead}>
                      <h3 className={styles.chartTitle}>Traffic Sources</h3>
                      <span className={styles.chartSub}>Top referrers · shown as sites</span>
                    </div>
                    <HBarChart
                      data={refRows}
                      max={Math.max(1, ...refRows.map(([, v]) => v))}
                    />
                  </div>
                )}

                {analytics.top_categories.length > 0 && (
                  <div className={styles.chartCard}>
                    <div className={styles.chartHead}>
                      <h3 className={styles.chartTitle}>Popular Categories</h3>
                      <span className={styles.chartSub}>Most viewed category pages</span>
                    </div>
                    <HBarChart
                      data={analytics.top_categories.map(c => [c.path.replace('/category/', ''), c.views])}
                      max={Math.max(1, ...analytics.top_categories.map(c => c.views))}
                      color={IZ.violet}
                    />
                  </div>
                )}

                {analytics.top_parts.length > 0 && (
                  <div className={styles.chartCard}>
                    <div className={styles.chartHead}>
                      <h3 className={styles.chartTitle}>Popular Parts</h3>
                      <span className={styles.chartSub}>Most viewed part pages</span>
                    </div>
                    <HBarChart
                      data={analytics.top_parts.map(p => [p.path.replace('/part/', ''), p.views])}
                      max={Math.max(1, ...analytics.top_parts.map(p => p.views))}
                      color={IZ.gold}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
