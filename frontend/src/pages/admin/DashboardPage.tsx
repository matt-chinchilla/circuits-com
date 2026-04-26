import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Upload, Download } from 'lucide-react'
import { useDemo } from '../../contexts/DemoContext'
import { adminApi } from '../../services/adminApi'
import type { DashboardStats, ActivityItem, RevenueDataPoint } from '../../types/admin'
import styles from './DashboardPage.module.scss'

// ─── Sparkline (12-pt mini area chart) ─────────────────────────────────────

interface SparklineProps {
  data: number[]
  color: string
  height?: number
  width?: number
}

function Sparkline({ data, color, height = 28, width = 84 }: SparklineProps) {
  if (data.length < 2) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => [i * step, height - ((v - min) / range) * (height - 2) - 1] as const)
  const d = pts.reduce((acc, [x, y], i) => acc + (i ? ` L${x.toFixed(1)} ${y.toFixed(1)}` : `M${x.toFixed(1)} ${y.toFixed(1)}`), '')
  const area = d + ` L${width} ${height} L0 ${height} Z`
  const gradId = `sg-${color.replace(/[^a-z0-9]/gi, '')}`
  return (
    <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={styles.sparklinePath} />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill={color} className={styles.sparklineDot} />
    </svg>
  )
}

// ─── Revenue area chart (smoothed cubic-bezier) ────────────────────────────

interface RevenueChartProps {
  data: { l: string; v: number }[]
}

function RevenueChart({ data }: RevenueChartProps) {
  if (data.length < 2) {
    return <div className={styles.emptyChart}>No revenue data yet.</div>
  }
  const W = 640, H = 200, P = 28
  const max = Math.max(...data.map((d) => d.v))
  const step = (W - P * 2) / (data.length - 1)
  const pts = data.map((d, i) => [P + i * step, H - P - (d.v / Math.max(max, 1)) * (H - P * 2)] as const)
  const path = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M${x} ${y}`
    const [px, py] = pts[i - 1]
    const cx1 = px + (x - px) / 2
    const cx2 = px + (x - px) / 2
    return acc + ` C${cx1} ${py} ${cx2} ${y} ${x} ${y}`
  }, '')
  const area = path + ` L${W - P} ${H - P} L${P} ${H - P} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.revChart} preserveAspectRatio="none">
      <defs>
        <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a4a2e" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#0a4a2e" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((t, i) => (
        <line key={i} x1={P} x2={W - P} y1={P + (H - P * 2) * t} y2={P + (H - P * 2) * t} stroke="#e5e7eb" strokeDasharray="2 4" />
      ))}
      <path d={area} fill="url(#rev-grad)" className={styles.revArea} />
      <path d={path} fill="none" stroke="#0a4a2e" strokeWidth="2" strokeLinecap="round" className={styles.revLine} />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="3" fill="#fff" stroke="#0a4a2e" strokeWidth="1.6" className={styles.revDot} style={{ animationDelay: `${i * 60}ms` }} />
      ))}
      {data.map((d, i) => (
        <text key={i} x={pts[i][0]} y={H - 8} textAnchor="middle" className={styles.revLabel}>{d.l}</text>
      ))}
    </svg>
  )
}

// ─── Sponsor donut (segment-draw animation + legend) ───────────────────────

interface Tier { n: string; v: number; c: string }

function SponsorRing({ tiers }: { tiers: Tier[] }) {
  const total = tiers.reduce((s, t) => s + t.v, 0)
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className={styles.ringWrap}>
      <svg viewBox="0 0 140 140" className={styles.ring}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="#f0f2f5" strokeWidth="14" />
        {tiers.map((t, i) => {
          const len = total > 0 ? (t.v / total) * C : 0
          const seg = (
            <circle
              key={i}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={t.c}
              strokeWidth="14"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              className={styles.ringSeg}
              style={{ animationDelay: `${i * 120}ms` }}
            />
          )
          offset += len
          return seg
        })}
        <text x="70" y="66" textAnchor="middle" className={styles.ringNum}>{total}</text>
        <text x="70" y="84" textAnchor="middle" className={styles.ringLbl}>sponsors</text>
      </svg>
      <div className={styles.ringLegend}>
        {tiers.map((t) => (
          <div key={t.n} className={styles.ringRow}>
            <span className={styles.ringSwatch} style={{ background: t.c }} />
            <span className={styles.ringName}>{t.n}</span>
            <span className={styles.ringVal}>{t.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Stat card (label + value + delta + sparkline) ─────────────────────────

interface StatProps {
  label: string
  value: string
  delta?: string | null
  deltaDir?: 'up' | 'down'
  hint: string
  series: number[]
  color: string
}

function Stat({ label, value, delta, deltaDir = 'up', hint, series, color }: StatProps) {
  return (
    <div className={styles.stat}>
      <div className={styles.statHead}>
        <span className={styles.statLabel}>{label}</span>
        {delta && (
          <span className={`${styles.statDelta} ${deltaDir === 'up' ? styles.up : styles.down}`}>
            {deltaDir === 'up' ? '▲' : '▼'} {delta}
          </span>
        )}
      </div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statFoot}>
        <span className={styles.statHint}>{hint}</span>
        <Sparkline data={series} color={color} />
      </div>
    </div>
  )
}

// ─── Quick actions bar ─────────────────────────────────────────────────────

function QuickActions() {
  return (
    <div className={styles.qaBar}>
      <span className={styles.qaTitle}>Quick actions</span>
      <Link to="/admin/parts/new" className={styles.qaBtn}>
        <Plus size={14} strokeWidth={2} />Add Part
      </Link>
      <Link to="/admin/suppliers/new" className={styles.qaBtn}>
        <Plus size={14} strokeWidth={2} />Add Supplier
      </Link>
      <Link to="/admin/sponsors/new" className={styles.qaBtn}>
        <Plus size={14} strokeWidth={2} />New Sponsor
      </Link>
      <Link to="/admin/import" className={styles.qaBtn}>
        <Upload size={14} strokeWidth={2} />Import CSV
      </Link>
    </div>
  )
}

// ─── Realistic-looking activity defaults (demo mode) ───────────────────────

const DEMO_ACTIVITY = [
  { i: 'ok' as const, e: '✓', t: <>Approved <b>Digi-Key</b> price update for <span className="mono">STM32F407VGT6</span></>, w: '4m ago' },
  { i: 'info' as const, e: '↻', t: <>Mouser imported <b>3,421</b> new parts in category <b>Analog ICs</b></>, w: '22m ago' },
  { i: 'warn' as const, e: '!', t: <>MX25L12833FM2I-10G flagged <b>Obsolete</b> by Macronix</>, w: '1h ago' },
  { i: 'ok' as const, e: '+', t: <>New supplier onboarded: <b>Future Electronics</b></>, w: '3h ago' },
  { i: 'info' as const, e: '◷', t: <>Weekly stock sync completed · <b>186</b> distributors</>, w: '6h ago' },
]

const DEMO_QUEUE = [
  { filename: 'digikey-q4-pricing.csv', size: '4.2 MB', rows: 18432, status: 'pending' as const },
  { filename: 'mouser-analog-ics.csv', size: '2.1 MB', rows: 9201, status: 'approved' as const },
  { filename: 'arrow-mcus-restock.csv', size: '892 KB', rows: 2412, status: 'pending' as const },
  { filename: 'newark-passives-week48.csv', size: '1.4 MB', rows: 5128, status: 'approved' as const },
]

// ─── Page ──────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { demoMode } = useDemo()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([])

  useEffect(() => {
    if (!demoMode) {
      setStats({ parts_count: 0, suppliers_count: 0, revenue_total: 0, sponsors_count: 0 })
      setActivity([])
      setRevenue([])
      return
    }
    Promise.all([adminApi.getStats(), adminApi.getActivity(), adminApi.getRevenue()])
      .then(([s, a, r]) => {
        setStats(s)
        setActivity(a)
        setRevenue(r)
      })
      .catch((err) => {
        console.error('[DashboardPage] demo data fetch failed', err)
      })
  }, [demoMode])

  // Sparkline series — bundle's hand-tuned arcs in demo mode; flat in real.
  const series = demoMode
    ? {
        parts: [40, 44, 48, 52, 58, 62, 70, 78, 85, 92, 98, 110],
        suppliers: [120, 128, 140, 152, 161, 170, 176, 181, 183, 184, 185, 186],
        revenue: [12, 18, 14, 22, 28, 24, 32, 38, 34, 44, 52, 58],
        pending: [4, 8, 6, 10, 14, 12, 9, 11, 14, 10, 13, 12],
      }
    : { parts: [8, 8.2, 8.5, 9, 9.4, 10, 10.5, 11, 11.6, 12, 12.4, 12.8], suppliers: [2, 3, 3, 4, 5, 5, 6, 6, 6, 7, 7, 8], revenue: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pending: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }

  const partsValue = demoMode ? '2,487,302' : (stats?.parts_count ?? 0).toLocaleString()
  const supValue = demoMode ? '186' : (stats?.suppliers_count ?? 0).toString()
  const revValue = demoMode ? '$184,320' : `$${(stats?.revenue_total ?? 0).toLocaleString()}`
  const spnValue = demoMode ? '186' : (stats?.sponsors_count ?? 0).toString()

  // Bundle's smoothed-bezier RevenueChart accepts a {l,v}[] series; map the
  // adminApi RevenueDataPoint[] to that shape (use total or fall back to 0).
  const revChartData = demoMode
    ? [12, 18, 14, 22, 28, 24, 32, 38, 34, 44, 52, 58].map((v, i) => ({ l: `W${i + 1}`, v }))
    : (revenue.length > 0
        ? revenue.map((r, i) => ({ l: r.month?.slice(0, 3) || `W${i + 1}`, v: r.total ?? 0 }))
        : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((v, i) => ({ l: `W${i + 1}`, v })))

  const sponsorTiers: Tier[] = demoMode
    ? [
        { n: 'Featured', v: 12, c: '#a88d2e' },
        { n: 'Platinum', v: 34, c: '#0a4a2e' },
        { n: 'Gold', v: 58, c: '#d97706' },
        { n: 'Silver', v: 82, c: '#94a3b8' },
      ]
    : [
        { n: 'Featured', v: 0, c: '#a88d2e' },
        { n: 'Platinum', v: 0, c: '#0a4a2e' },
        { n: 'Gold', v: 0, c: '#d97706' },
        { n: 'Silver', v: 0, c: '#94a3b8' },
      ]

  const activityRows = demoMode ? DEMO_ACTIVITY : activity.map((a) => ({
    i: 'info' as const,
    e: '·',
    t: <>{a.description}</>,
    w: a.created_at ? new Date(a.created_at).toLocaleDateString() : '',
  }))

  return (
    <div>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Dashboard</h1>
          <p>Catalog health · finances · recent activity</p>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`}>
          <Download size={15} strokeWidth={2} />Export report
        </button>
      </div>

      <QuickActions />

      <div className={styles.stats}>
        <Stat
          label="Total Parts"
          value={partsValue}
          delta={demoMode ? '2.4%' : null}
          deltaDir="up"
          hint={demoMode ? 'vs last week' : 'real catalog'}
          series={series.parts}
          color="#0a4a2e"
        />
        <Stat
          label="Active Suppliers"
          value={supValue}
          delta={demoMode ? '4 new' : null}
          deltaDir="up"
          hint="this month"
          series={series.suppliers}
          color="#2563eb"
        />
        <Stat
          label="Monthly Revenue"
          value={revValue}
          delta={demoMode ? '18.2%' : null}
          deltaDir="up"
          hint={demoMode ? 'recurring + spot' : 'not monetized yet'}
          series={series.revenue}
          color="#a88d2e"
        />
        <Stat
          label="Active Sponsors"
          value={spnValue}
          hint="paying tiers"
          series={series.pending}
          color="#7c3aed"
        />
      </div>

      <div className={styles.aTwo}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>Revenue</h3>
              <p className={styles.panelSub}>Weekly gross · last 12 weeks</p>
            </div>
            <div className={styles.panelLegend}>
              <span className={styles.legendDot} style={{ background: '#0a4a2e' }} />
              Gross revenue
            </div>
          </div>
          <div className={styles.panelBody}>
            <RevenueChart data={revChartData} />
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>Active Sponsors</h3>
              <p className={styles.panelSub}>By tier · monetization mix</p>
            </div>
            <Link to="/admin/sponsors" className={styles.panelLink}>Manage →</Link>
          </div>
          <div className={styles.panelBody}>
            <SponsorRing tiers={sponsorTiers} />
          </div>
        </div>
      </div>

      <div className={styles.aTwo}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Recent Activity</h3>
            <span className={styles.panelLink}>View all →</span>
          </div>
          <div className={styles.activity}>
            {activityRows.length === 0 ? (
              <div className={styles.empty}>No recent activity.</div>
            ) : (
              activityRows.map((r, idx) => (
                <div key={idx} className={styles.activityRow}>
                  <div className={`${styles.activityIcon} ${styles[r.i]}`}>{r.e}</div>
                  <div className={styles.activityText}>{r.t}</div>
                  <div className={styles.activityTime}>{r.w}</div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Import Queue</h3>
            <Link to="/admin/import" className={styles.panelLink}>Review all →</Link>
          </div>
          <div className={styles.queue}>
            {(demoMode ? DEMO_QUEUE : []).map((q, idx) => (
              <div key={idx} className={styles.queueRow}>
                <div>
                  <div className={styles.queueName}>{q.filename}</div>
                  <div className={styles.queueMeta}>{q.size} · {q.rows.toLocaleString()} rows</div>
                </div>
                <span className={`${styles.queuePill} ${styles[q.status]}`}>{q.status}</span>
              </div>
            ))}
            {!demoMode && (
              <div className={styles.empty}>No imports pending review.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
