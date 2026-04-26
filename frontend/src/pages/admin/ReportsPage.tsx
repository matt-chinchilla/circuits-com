import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { useDemo } from '../../contexts/DemoContext'
import { adminApi } from '../../services/adminApi'
import type { RevenueDataPoint, PopularData } from '../../types/admin'
import styles from './ReportsPage.module.scss'

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

function ReportsRevenueChart({ series }: ReportsRevenueChartProps) {
  const [hover, setHover] = useState<number | null>(null)

  if (series.length < 2) {
    return <div className={styles.empty}>No revenue data yet.</div>
  }

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
  const xs: number[] = []
  for (let i = 0; i < N; i++) xs.push(PAD_L + (i / (N - 1)) * innerW)
  const yScale = (v: number) => PAD_T + innerH - (v / maxV) * innerH

  const sponsorTop = series.map((d) => d.listing + d.sponsor)

  // Listing-fees area (bottom band)
  let listingPath = `M ${xs[0]},${yScale(0)}`
  for (let i = 0; i < N; i++) listingPath += ` L ${xs[i]},${yScale(series[i].listing)}`
  listingPath += ` L ${xs[N - 1]},${yScale(0)} Z`

  // Sponsorship area (stacked above listings)
  let sponsorPath = `M ${xs[0]},${yScale(series[0].listing)}`
  for (let i = 0; i < N; i++) sponsorPath += ` L ${xs[i]},${yScale(sponsorTop[i])}`
  for (let i = N - 1; i >= 0; i--) sponsorPath += ` L ${xs[i]},${yScale(series[i].listing)}`
  sponsorPath += ' Z'

  // Total trendline (sponsor-top)
  let totalLine = ''
  for (let i = 0; i < N; i++) {
    totalLine += (i === 0 ? 'M ' : ' L ') + xs[i] + ',' + yScale(sponsorTop[i])
  }

  const tickStep = maxV / 4
  const yTicks = [0, tickStep, tickStep * 2, tickStep * 3, maxV]

  const tipData = hover !== null ? series[hover] : null
  const tipX = hover !== null ? Math.min(W - 170, Math.max(PAD_L, xs[hover] + 14)) : 0
  const tipY = 20

  return (
    <div className={styles.chartWrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chart}
        onMouseLeave={() => setHover(null)}
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="#e7e5e0"
              strokeDasharray="3 4"
            />
            <text
              x={PAD_L - 8}
              y={yScale(t) + 4}
              textAnchor="end"
              fontSize="11"
              fill="#7a756d"
              fontFamily="JetBrains Mono"
            >
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {series.map((d, i) =>
          i % 2 === 0 ? (
            <text
              key={d.m}
              x={xs[i]}
              y={H - PAD_B + 18}
              textAnchor="middle"
              fontSize="11"
              fill="#7a756d"
              fontFamily="JetBrains Mono"
            >
              {d.m}
            </text>
          ) : null
        )}
        <path d={listingPath} fill="rgba(10, 74, 46, 0.18)" className={styles.revArea} />
        <path d={sponsorPath} fill="rgba(168, 141, 46, 0.32)" className={styles.revArea} />
        <path
          d={totalLine}
          fill="none"
          stroke="#0a4a2e"
          strokeWidth="2"
          className={styles.revLine}
        />
        {hover !== null && (
          <line
            x1={xs[hover]}
            x2={xs[hover]}
            y1={PAD_T}
            y2={H - PAD_B}
            stroke="#7a756d"
            strokeDasharray="2 3"
            opacity="0.5"
          />
        )}
        {series.map((d, i) => (
          <g key={d.m}>
            <rect
              x={xs[i] - innerW / (N * 2)}
              y={PAD_T}
              width={innerW / N}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
            <circle
              cx={xs[i]}
              cy={yScale(sponsorTop[i])}
              r={hover === i ? 5 : 3}
              fill="#0a4a2e"
              stroke="#fff"
              strokeWidth="2"
            />
          </g>
        ))}
      </svg>
      {tipData && (
        <div
          className={styles.revTip}
          style={{
            position: 'absolute',
            left: `${(tipX / W) * 100}%`,
            top: `${(tipY / H) * 100}%`,
            width: 160,
          }}
        >
          <div className={styles.revTipTitle}>{tipData.m}</div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: '#a88d2e' }} />
            Sponsor<b>${tipData.sponsor.toLocaleString()}</b>
          </div>
          <div className={styles.revTipRow}>
            <span className="dot" style={{ background: '#0a4a2e' }} />
            Listings<b>${tipData.listing.toLocaleString()}</b>
          </div>
          <div className={styles.revTipTotal}>
            Total <b>${(tipData.listing + tipData.sponsor).toLocaleString()}</b>
          </div>
        </div>
      )}
      <div className={styles.chartLegend}>
        <span>
          <i className="dot" style={{ background: '#a88d2e' }} />
          Sponsorship
        </span>
        <span>
          <i className="dot" style={{ background: '#0a4a2e' }} />
          Listing fees
        </span>
        <span>
          <i className="dash" style={{ background: '#0a4a2e' }} />
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
        <circle cx="100" cy="100" r="60" fill="none" stroke="#f0f2f5" strokeWidth="22" />
        <g transform="rotate(-90 100 100)">
          <circle
            cx="100"
            cy="100"
            r="60"
            fill="none"
            stroke="#a88d2e"
            strokeWidth="22"
            strokeDasharray={`${sLen} ${C}`}
            className={`${styles.donutArc} ${styles.sArc}`}
          />
          <circle
            cx="100"
            cy="100"
            r="60"
            fill="none"
            stroke="#0a4a2e"
            strokeWidth="22"
            strokeDasharray={`${lLen} ${C}`}
            strokeDashoffset={-sLen}
            className={`${styles.donutArc} ${styles.lArc}`}
          />
        </g>
        <text x="100" y="92" textAnchor="middle" fontSize="13" fill="#6b7280">
          Total YTD
        </text>
        <text
          x="100"
          y="116"
          textAnchor="middle"
          fontSize="22"
          fontWeight="700"
          fill="#111827"
          fontFamily="JetBrains Mono"
        >
          ${(total / 1000).toFixed(1)}k
        </text>
      </svg>
      <div className={styles.donutLegend}>
        <div className={styles.donutRow}>
          <span className="dot" style={{ background: '#a88d2e' }} />
          <span>sponsorship</span>
          <span className="pct">{Math.round(sPct * 100)}%</span>
        </div>
        <div className={styles.donutRow}>
          <span className="dot" style={{ background: '#0a4a2e' }} />
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

function HBarChart({ data, max, fmt = (v: number) => `${v}`, color = '#0a4a2e' }: HBarChartProps) {
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
                background: color,
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

// ─── Page ───────────────────────────────────────────────────────────────────

type RangeKey = '30d' | '90d' | '12m' | 'All'
type TabKey = 'analytics' | 'exports'

export default function ReportsPage() {
  const { demoMode } = useDemo()
  const [range, setRange] = useState<RangeKey>('12m')
  const [tab, setTab] = useState<TabKey>('analytics')
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([])
  const [popular, setPopular] = useState<PopularData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (demoMode) {
      setRevenue([])
      setPopular(null)
      setLoading(false)
      setError('')
      return
    }
    setLoading(true)
    Promise.all([adminApi.getRevenue(), adminApi.getPopular()])
      .then(([r, p]) => {
        setRevenue(r)
        setPopular(p)
        setError('')
      })
      .catch(() => setError('Failed to load report data.'))
      .finally(() => setLoading(false))
  }, [demoMode])

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

  const sponsorsActive = demoMode ? 12 : 0
  const partsIndexed = demoMode ? 2_487_302 : 0
  const suppliersActive = demoMode ? 186 : 0

  const partsByCatMax = Math.max(16, ...partsByCat.map(([, v]) => v))
  const topSuppliersMax = Math.max(32, ...topSuppliers.map(([, v]) => v))

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
            {(['30d', '90d', '12m', 'All'] as const).map((r) => (
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
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'analytics' && (
        <>
          <div className={styles.repKpiRow}>
            <div className={styles.repKpi}>
              <div className={styles.repKpiLabel}>YTD revenue</div>
              <div className={styles.repKpiVal}>${ytd.toLocaleString()}</div>
              <div
                className={`${styles.repKpiDelta} ${mom >= 0 ? styles.up : styles.down}`}
              >
                {mom >= 0 ? '▲' : '▼'} {Math.abs(mom).toFixed(1)}% vs last month
              </div>
            </div>
            <div className={styles.repKpi}>
              <div className={styles.repKpiLabel}>Active sponsors</div>
              <div className={styles.repKpiVal}>{sponsorsActive}</div>
              <div className={`${styles.repKpiDelta} ${styles.up}`}>
                ▲ 2 new this quarter
              </div>
            </div>
            <div className={styles.repKpi}>
              <div className={styles.repKpiLabel}>Parts indexed</div>
              <div className={styles.repKpiVal}>{partsIndexed.toLocaleString()}</div>
              <div className={`${styles.repKpiDelta} ${styles.up}`}>▲ 1.2% wk/wk</div>
            </div>
            <div className={styles.repKpi}>
              <div className={styles.repKpiLabel}>Suppliers active</div>
              <div className={styles.repKpiVal}>{suppliersActive}</div>
              <div className={`${styles.repKpiDelta} ${styles.neutral}`}>→ steady</div>
            </div>
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
                color="#a88d2e"
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
    </div>
  )
}
