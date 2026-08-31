import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Download } from 'lucide-react'
import { useDemo } from '@admin/contexts/DemoContext'
import { useAuth } from '@admin/contexts/AuthContext'
import { adminApi } from '@admin/services/adminApi'
import type {
  AnalyticsData,
  AnalyticsSegment,
  DashboardStats,
  RevenueDataPoint,
  PopularData,
} from '@admin/types/admin'
import CustomerReportsPage from './CustomerReportsPage'
import { pageLabel, pageUrl } from './pageLabels'
import styles from './ReportsPage.module.scss'
import WorldMapPanel from './WorldMapPanel'
import OrganizationsPanel from './organizations'
import { focusFor, type LocationFocus } from './locationFocus'
import { refHost } from './chartKit'
import { IZ } from './chartParts'
import {
  DeviceDonut,
  DeviceTrendChart,
  HBarChart,
  ReportsRevenueChart,
  RevenueDonut,
  TrafficChart,
} from './charts'
import type { RevSeriesPoint } from './charts'

// ReportsPage — Phase A7 port of the 2026-04-25 Claude Design bundle.
// The hand-rolled native SVG charts live in charts.tsx (replaces Recharts
// ~400KB); this file owns the page shell, tabs, KPIs and data fetching.

// ─── Demo data (bundle's hand-tuned 12-month series) ────────────────────────

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

function StaffReportsPage() {
  const { demoMode } = useDemo()
  const [range, setRange] = useState<RangeKey>('12m')
  const [tab, setTab] = useState<TabKey>('analytics')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([])
  const [popular, setPopular] = useState<PopularData | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  // "Show me that place on the map" — raised by a location click in the
  // Visiting Organizations panel and handed to the map above it. The page
  // holds it because the two are SIBLINGS; a store would be a second source
  // of truth about which place is selected, and the map already owns that.
  // The counter is what makes a repeat click on the same location re-fire.
  const [mapFocus, setMapFocus] = useState<LocationFocus | null>(null)
  const focusSeq = useRef(0)
  const focusLocation = useCallback((location: Parameters<typeof focusFor>[0]) => {
    focusSeq.current += 1
    const next = focusFor(location, focusSeq.current)
    if (next) setMapFocus(next)
  }, [])

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
                  ? 'Crawlers have been filtered out, people only'
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
                  value={pageUrl(analytics.top_pages[0]?.path)}
                  valueStyle={{ fontSize: 16 }}
                  delta={`${analytics.top_pages[0]?.views ?? 0} views`}
                />
              </div>

              <div className={styles.chartsGrid}>
                <WorldMapPanel
                  countries={analytics.countries}
                  geoTrackedSince={analytics.geo_tracked_since}
                  segment={analytics.segment}
                  days={RANGE_DAYS[range]}
                  usStates={analytics.us_states}
                  usCities={analytics.us_cities}
                  regionCountries={analytics.region_countries}
                  regionTrackedSince={analytics.region_tracked_since}
                  locatedTowns={analytics.located_towns}
                  focus={mapFocus}
                />

                <OrganizationsPanel
                  days={RANGE_DAYS[range]}
                  segment={segment}
                  onFocusLocation={focusLocation}
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
                            <td className={styles.pathCell} title={pageUrl(p.path)}>
                              {pageLabel(p.path)}
                            </td>
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

// The route component. Every endpoint the staff page reads is require_staff and
// platform-wide, so a customer gets a different page over the SAME customer
// panels — see CustomerReportsPage. The staff body above is unchanged by the
// split.
export default function ReportsPage() {
  const { isCustomer } = useAuth()
  return isCustomer ? <CustomerReportsPage /> : <StaffReportsPage />
}
