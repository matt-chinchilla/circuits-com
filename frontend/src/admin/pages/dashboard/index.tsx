// DashboardPage — the admin console home.
//
// This file is the SHELL only: it fetches, branches on demo mode, and lays the
// widgets out. Every widget lives in ./components and owns its own chart option
// and empty state. Charts go through `<EChart>` (which disposes its zrender
// instance on unmount) — never a hand-rolled SVG and never a bare
// `echarts.init`.
//
// ── Demo mode ──────────────────────────────────────────────────────────────
// `DemoContext.demoMode` is ON by default and the console gets shown to
// prospects long before the live catalog has a believable P&L. Demo fakes the
// VALUES, never the SHAPE: the day axis, month keys and month lengths come from
// the real ET calendar either way, so switching the toggle re-labels nothing.
//
// ── Who is reading ────────────────────────────────────────────────────────
// Every request below is staff-gated, so a CUSTOMER never mounts this page at
// all: `DashboardPage` is a two-line switch and the customer's console home is
// `./CustomerDashboard`. Not mounting is what makes "zero staff calls" true —
// a branch inside the render would still have fired these effects.
//
// ── Fetching ───────────────────────────────────────────────────────────────
// Three effects: one for the range-independent payloads and one each for the
// two comparators (whose `months` query changes with their segmented control).
// Each request is individually `.catch`-ed to a neutral fallback so one failing
// endpoint degrades a single widget instead of blanking the page, and each
// effect carries the repo's cancel flag so a late resolve cannot set state on
// an unmounted page.

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useAuth } from '@admin/contexts/AuthContext';
import { useDemo } from '@admin/contexts/DemoContext';
import { adminApi } from '@admin/services/adminApi';
import { useCachedQuery } from '@admin/services/queryCache';
import { ChartMotion } from '@admin/components/charts/ChartMotion';
import { countActiveSponsorsByTier } from '@admin/services/sponsorTier';
import type {
  ActivityItem,
  AdminSponsor,
  DashboardStats,
  DashboardTrends,
  ExpensesBreakdown,
  MonthlyCompareMonth,
  SalesRep,
  SponsorTier,
  TrendPoint,
} from '@admin/types/admin';
import type { PlatformEngagementSeries } from '@admin/types/engagement';
import CustomerDashboard from './CustomerDashboard';
import ActivityPanel from './components/ActivityPanel';
import EngagementPanel from './components/EngagementPanel';
import ExpenseBreakdownPanel from './components/ExpenseBreakdownPanel';
import ExpensesPanel from './components/ExpensesPanel';
import ImportQueuePanel from './components/ImportQueuePanel';
import LeadsPanel from './components/LeadsPanel';
import QuickActions from './components/QuickActions';
import RevenuePanel, { type CompareRange } from './components/RevenuePanel';
import SalesRepsPanel from './components/SalesRepsPanel';
import SponsorMixPanel from './components/SponsorMixPanel';
import StatCard from './components/StatCard';
import TrafficPanel from './components/TrafficPanel';
import {
  DEMO_SALES_REPS,
  DEMO_STATS,
  DEMO_TIER_COUNTS,
  demoExpensesBreakdown,
  demoMonthlyCompare,
  demoTrend,
} from './components/demoData';
import { count, estDayWindow, estToday, usd } from './components/format';
import { monthTotal } from './components/monthlySeries';
import styles from './DashboardPage.module.scss';

const TREND_DAYS = 30;

interface DashboardCore {
  stats: DashboardStats | null;
  activity: ActivityItem[];
  sponsors: AdminSponsor[];
  trends: DashboardTrends | null;
  salesReps: SalesRep[];
  breakdown: ExpensesBreakdown | null;
  engagement: PlatformEngagementSeries[];
}

const EMPTY_ACTIVITY: ActivityItem[] = [];
const EMPTY_SPONSORS: AdminSponsor[] = [];
const EMPTY_REPS: SalesRep[] = [];
const EMPTY_ENGAGEMENT: PlatformEngagementSeries[] = [];
const EMPTY_MONTHS: MonthlyCompareMonth[] = [];

// The range-independent payloads, fetched in parallel and cached as ONE entry
// so a revisit is a single equality check rather than seven. Each read is
// best-effort: a failed panel degrades to its empty state, never the page.
async function loadDashboardCore(): Promise<DashboardCore> {
  const [stats, activity, sponsors, trends, reps, breakdown, engagement] = await Promise.all([
    adminApi.getStats().catch(() => null),
    adminApi.getActivity().catch(() => [] as ActivityItem[]),
    adminApi.getSponsors().catch(() => [] as AdminSponsor[]),
    adminApi.getTrends(TREND_DAYS).catch(() => null),
    adminApi.getSalesReps().catch(() => ({ reps: [] as SalesRep[] })),
    adminApi.getExpensesBreakdown().catch(() => null),
    // Stub today — resolves [] until the engagement endpoint lands.
    adminApi.getEngagement(TREND_DAYS).catch(() => [] as PlatformEngagementSeries[]),
  ]);
  return { stats, activity, sponsors, trends, salesReps: reps.reps ?? [], breakdown, engagement };
}

const EMPTY_TIER_COUNTS: Record<SponsorTier, number> = { Platinum: 0, Gold: 0, Silver: 0 };

export default function DashboardPage() {
  const { isCustomer } = useAuth();
  // A switch, not a branch inside one component: the two sides hold different
  // hooks, and mounting the staff tree for a customer is what would fire the
  // staff requests.
  return isCustomer ? <CustomerDashboard /> : <StaffDashboard />;
}

function StaffDashboard() {
  const { demoMode } = useDemo();

  // ── Data ─────────────────────────────────────────────────────────────────
  // Every read goes through the module-level query cache (owner, 2026-09-03:
  // "going back to the dashboard should not require a re-query every time").
  // A revisit inside the freshness window renders synchronously from memory
  // with NO request; a stale revisit renders from memory and refreshes in the
  // background, re-rendering only if a payload actually changed; the first
  // visit is the only one that shows the skeletons. `demoMode` is deliberately
  // not part of any key — the payload is the same either way, the demo branch
  // just renders generated data instead.
  const core = useCachedQuery('dashboard:core', loadDashboardCore);

  // TODO: move both windows to Settings — they are a per-admin preference, not
  // page state. Local `useState` keeps this shippable without a settings
  // migration; the two are independent on purpose (costs are usually read over
  // a longer horizon than bookings).
  const [revenueRange, setRevenueRange] = useState<CompareRange>(3);
  const [expenseRange, setExpenseRange] = useState<CompareRange>(3);
  // One query EACH, keyed on its own window: a combined key would refetch both
  // endpoints every time either segmented control moved.
  const revenue = useCachedQuery(`dashboard:revenue:${revenueRange}`, () =>
    adminApi.getRevenueCompare(revenueRange).catch(() => ({ months: [] as MonthlyCompareMonth[] })),
  );
  const expenses = useCachedQuery(`dashboard:expenses:${expenseRange}`, () =>
    adminApi.getExpenses(expenseRange).catch(() => ({ months: [] as MonthlyCompareMonth[] })),
  );

  // Stable empties (module-level) so the memos below don't re-run on every
  // render while a payload is still missing.
  const stats = core.data?.stats ?? null;
  const activity = core.data?.activity ?? EMPTY_ACTIVITY;
  const sponsors = core.data?.sponsors ?? EMPTY_SPONSORS;
  const trends = core.data?.trends ?? null;
  const salesReps = core.data?.salesReps ?? EMPTY_REPS;
  const breakdown = core.data?.breakdown ?? null;
  const engagement = core.data?.engagement ?? EMPTY_ENGAGEMENT;
  const loading = core.loading;
  const revenueMonths = revenue.data?.months ?? EMPTY_MONTHS;
  const expenseMonths = expenses.data?.months ?? EMPTY_MONTHS;
  const revenueLoading = revenue.loading;
  const expenseLoading = expenses.loading;

  // ── Derived: day axis ────────────────────────────────────────────────────
  // Demo curves ride the REAL ET day axis, so the hover readout names a real
  // date in both modes. The locally generated window is only a fallback for
  // when /trends has not answered (or failed).
  const dayAxis = useMemo(() => {
    const days = trends?.series.parts.map((p) => p.day);
    return days && days.length > 0 ? days : estDayWindow(TREND_DAYS);
  }, [trends]);

  const todayDayOfMonth = useMemo(() => estToday().day, []);

  const series = useMemo(() => {
    if (demoMode) {
      return {
        parts: demoTrend(dayAxis, 2_180_000, DEMO_STATS.parts, 11, 0.012),
        suppliers: demoTrend(dayAxis, 148, DEMO_STATS.suppliers, 29, 0.02),
        // Daily bookings, deliberately scaled to the demo comparator base
        // below (~900/day) and the demo book of business (~$26k/mo) so the
        // three widgets tell one story rather than three.
        revenue: demoTrend(dayAxis, 700, 1_100, 47, 0.22),
        sponsors: demoTrend(dayAxis, 131, DEMO_STATS.sponsors, 83, 0.03),
        traffic: demoTrend(dayAxis, 640, 1_450, 101, 0.28),
      };
    }
    const empty: TrendPoint[] = [];
    return {
      parts: trends?.series.parts ?? empty,
      suppliers: trends?.series.suppliers ?? empty,
      revenue: trends?.series.revenue ?? empty,
      sponsors: trends?.series.sponsors ?? empty,
      traffic: trends?.series.traffic ?? empty,
    };
  }, [demoMode, dayAxis, trends]);

  // ── Derived: widget data ─────────────────────────────────────────────────
  const revenueData = useMemo(
    () => (demoMode ? demoMonthlyCompare(revenueRange, 900, 5) : revenueMonths),
    [demoMode, revenueRange, revenueMonths],
  );

  const expenseData = useMemo(
    () => (demoMode ? demoMonthlyCompare(expenseRange, 9.4, 61, 0.97) : expenseMonths),
    [demoMode, expenseRange, expenseMonths],
  );

  const breakdownData = useMemo(
    () => (demoMode ? demoExpensesBreakdown() : breakdown),
    [demoMode, breakdown],
  );

  const repData = demoMode ? DEMO_SALES_REPS : salesReps;

  // Demo headline for Monthly Revenue: `/dashboard/stats.monthly_revenue`
  // whenever the current month actually has Revenue rows. The seeder's NEWEST
  // period is LAST month (`_seed_revenue` walks months_ago 12 → 1), so on
  // seeded data that figure is 0 — which would make demo mode look as unsold as
  // live mode. In that case the card falls back to the demo comparator's
  // month-to-date total, so the headline agrees with the chart right below it.
  const demoMonthlyRevenue = useMemo(() => {
    const reported = Number(stats?.monthly_revenue) || 0;
    if (reported > 0) return reported;
    return revenueData.length > 0 ? monthTotal(revenueData[0]) : 0;
  }, [stats, revenueData]);

  const tierCounts = useMemo(() => {
    if (demoMode) return DEMO_TIER_COUNTS;
    return sponsors.length > 0 ? countActiveSponsorsByTier(sponsors) : EMPTY_TIER_COUNTS;
  }, [demoMode, sponsors]);

  return (
    // Charts mounting from cached data paint without their draw-in; a refresh
    // that changes the data still animates the update.
    <ChartMotion animateEntry={!core.fromCache}>
    <div>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Dashboard</h1>
          <p>Catalog health &middot; finances &middot; recent activity</p>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`}>
          <Download size={15} strokeWidth={2} />
          Export report
        </button>
      </div>

      <QuickActions />

      <div className={styles.stats}>
        <StatCard
          label="Total Parts"
          value={demoMode ? count(DEMO_STATS.parts) : count(stats?.parts_count ?? 0)}
          delta={demoMode ? '2.4%' : null}
          hint={demoMode ? 'vs last week' : 'live catalog'}
          series={series.parts}
          tone="green"
          valueFormat={count}
        />
        <StatCard
          label="Active Suppliers"
          value={demoMode ? count(DEMO_STATS.suppliers) : count(stats?.suppliers_count ?? 0)}
          delta={demoMode ? '4 new' : null}
          hint="this month"
          series={series.suppliers}
          tone="blue"
          valueFormat={count}
        />
        {/* Live mode is deliberately a hard $0.00: nothing is billed yet, and
            showing seeded demo revenue as a real figure would be a lie about
            the business. Demo mode shows the seeded monthly total. */}
        <StatCard
          label="Monthly Revenue"
          value={demoMode ? usd(demoMonthlyRevenue) : usd(0)}
          delta={demoMode ? '18.2%' : null}
          hint={
            demoMode
              ? 'recurring + spot'
              : 'Not monetized yet — connects to your payment processor'
          }
          series={series.revenue}
          tone="gold"
          valueFormat={usd}
        />
        <StatCard
          label="Active Sponsors"
          value={demoMode ? count(DEMO_STATS.sponsors) : count(stats?.sponsors_count ?? 0)}
          hint="paying tiers"
          series={series.sponsors}
          tone="purple"
          valueFormat={count}
        />
      </div>

      <div className={styles.aOne}>
        <RevenuePanel
          months={revenueData}
          range={revenueRange}
          onRangeChange={setRevenueRange}
          todayDayOfMonth={todayDayOfMonth}
          loading={revenueLoading}
        />
      </div>

      <div className={styles.aOne}>
        <SalesRepsPanel reps={repData} loading={loading} />
      </div>

      <div className={styles.aEven}>
        <SponsorMixPanel counts={tierCounts} loading={loading} />
        <TrafficPanel series={series.traffic} loading={loading} />
      </div>

      <div className={styles.aWide}>
        <ExpensesPanel
          months={expenseData}
          range={expenseRange}
          onRangeChange={setExpenseRange}
          todayDayOfMonth={todayDayOfMonth}
          loading={expenseLoading}
        />
        <ExpenseBreakdownPanel breakdown={breakdownData} loading={loading} />
      </div>

      <div className={styles.aOne}>
        <EngagementPanel series={engagement} loading={loading} />
      </div>

      {/* Fetches for itself — the leads feed is the one payload the server
          refuses for the demo account, and the panel owns that refusal. */}
      <div className={styles.aOne}>
        <LeadsPanel demoMode={demoMode} />
      </div>

      <div className={styles.aTwo}>
        <ActivityPanel activity={activity} demoMode={demoMode} />
        <ImportQueuePanel demoMode={demoMode} />
      </div>
    </div>
    </ChartMotion>
  );
}
