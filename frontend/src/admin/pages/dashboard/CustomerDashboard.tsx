// CustomerDashboard — the console home a CUSTOMER sees.
//
// A separate component rather than a branch inside the staff page, because the
// staff dashboard's seven `/api/dashboard/*` requests are all staff-gated: a
// customer who mounts that page does not get a smaller dashboard, they get
// seven 403s. Not mounting it is the only version of "hidden" the network tab
// agrees with, so the split is a component boundary and every request that
// does go out is an /api/account one, scoped server-side.
//
// ── The board ──────────────────────────────────────────────────────────────
// Ten panels under the tiles, laid out and drawn as the staff board's are —
// same panel chrome, same ECharts wrapper, same empty-state grammar. Panels
// that were purely presentational are reused outright (`sparklineOption`,
// `monthPager`, `format`); the ones entangled with staff fetching or with the
// demo fixtures have twins in ./components/customer, which is also the only
// place the customer board's own chart types are registered.
//
// Two rules hold this file together:
//  1. NO staff endpoint may be reached from here. `adminApi` is not imported,
//     and neither is `./components/demoData` — a customer's screen has no
//     honest use for invented numbers.
//  2. An UNLINKED account is a real, designed state, not an error. Every
//     endpoint answers 200 with zeros, and every panel below has an empty
//     state written for that case.
//
// `monthly_spend` is what this company PAYS US for its placements, so the tile
// says spend. It is the same money the staff dashboard reads as Monthly
// Revenue, from the other side of the invoice — printing it here under a
// revenue heading would tell a customer they earned their own bill.
//
// The tiles are the dashboard's own `.stat` chrome rather than `<StatCard>`:
// that component's sparkline is fed by the staff-only `/dashboard/trends`,
// which has no account-scoped twin, so every card here would render its blank
// anyway — and importing it would pull the async `echarts` chunk into a screen
// that draws no chart (see EChart's bundle-discipline note).

import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { useCachedQuery } from '@admin/services/queryCache';
import { ChartMotion } from '@admin/components/charts/ChartMotion';
import { tierColorSet } from '@admin/components/charts/chartTheme';
import type {
  AccountActivityEvent,
} from '@admin/types/account';
import ActivityPanel from './components/customer/ActivityPanel';
import BookOfBusinessPanel from './components/customer/BookOfBusinessPanel';
import EngagementPanel from './components/customer/EngagementPanel';
import ImportQueuePanel from './components/customer/ImportQueuePanel';
import KpiPanel from './components/customer/KpiPanel';
import LeadsPanel from './components/customer/LeadsPanel';
import OperatingCostsPanel from './components/customer/OperatingCostsPanel';
import ReferralClicksPanel from './components/customer/ReferralClicksPanel';
import RevenuePanel from './components/customer/RevenuePanel';
import SponsorMixPanel from './components/customer/SponsorMixPanel';
import TrafficPanel from './components/customer/TrafficPanel';
import { count, usd } from './components/format';
import styles from './DashboardPage.module.scss';

/**
 * TitleCase for the badge, read case-insensitively like every other tier site
 * in the console (`tierColorSet`, `normalizeSponsorTier`) — `tier` is derived
 * server-side from a free-string sponsor column, so nothing here compares
 * against a literal.
 */
function tierLabel(tier: string | null | undefined): string {
  const key = (tier ?? '').trim().toLowerCase();
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Free';
}

interface TileProps {
  label: string;
  value: string;
  hint: string;
  toneClass: string;
}

function Tile({ label, value, hint, toneClass }: TileProps) {
  return (
    <div className={`${styles.stat} ${toneClass}`}>
      <div className={styles.statHead}>
        <span className={styles.statLabel}>{label}</span>
      </div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statHint}>{hint}</div>
      {/* The same reserved strip a seriesless StatCard leaves, so a customer
          tile is the exact height of a staff one. */}
      <div className={styles.statSparkEmpty} aria-hidden="true" />
    </div>
  );
}

const EMPTY_EVENTS: AccountActivityEvent[] = [];

// Every request individually `.catch`-ed to a neutral fallback so one failing
// endpoint degrades a single panel instead of blanking the page.
async function loadAccountCore() {
  const [dash, clicks, rev, sponsorMix, counterparties, events, queue, spend, sales] =
    await Promise.all([
      accountApi.getAccountDashboard().catch(() => null),
      accountApi.getAccountReferralClicks().catch(() => null),
      accountApi.getAccountRevenue().catch(() => null),
      accountApi.getAccountSponsorMix().catch(() => null),
      accountApi.getAccountBookOfBusiness().catch(() => null),
      accountApi.getAccountActivity().catch(() => null),
      accountApi.getAccountImportQueue().catch(() => null),
      accountApi.getAccountOperatingCosts().catch(() => null),
      accountApi.getAccountLeadsSummary().catch(() => null),
    ]);
  return { dash, clicks, rev, sponsorMix, counterparties, events, queue, spend, sales };
}

export default function CustomerDashboard() {
  const { account } = useAuth();
  // The whole board is ONE cached entry (see the staff dashboard): a revisit
  // renders from memory with no request, a stale one refreshes in the
  // background and repaints only on a real change. The KPI panel is absent
  // from it on purpose — it owns a WRITE, and its PUT returns the recomputed
  // panel, so its read and its write are one piece of state inside it. The
  // costs panel takes its first month from here and fetches other months
  // itself, the way the staff cost breakdown does.
  const core = useCachedQuery('account:core', loadAccountCore);
  // Each stays null on failure, which renders em dashes and loading-less
  // empty states rather than zeroes: an unlinked account really does have
  // nothing, a failed request does not know.
  const data = core.data?.dash ?? null;
  const referrals = core.data?.clicks ?? null;
  const revenue = core.data?.rev ?? null;
  const mix = core.data?.sponsorMix ?? null;
  const book = core.data?.counterparties ?? null;
  const activity = core.data?.events?.events ?? EMPTY_EVENTS;
  const feed = core.data?.queue?.feed ?? null;
  const costs = core.data?.spend ?? null;
  const leads = core.data?.sales ?? null;
  const loading = core.loading;

  // Capability is the two links, read INDEPENDENTLY — both set is the normal
  // case for the largest distributors and neither set is the free browsing
  // account. This page needs only "is either set", but it never collapses them
  // into one enum on the way there.
  const isSupplier = account?.is_supplier === true;
  const isManufacturer = account?.is_manufacturer === true;
  const linked = isSupplier || isManufacturer;

  // The dashboard's own tier is the server's freshest word on it; the probe
  // body is the fallback while that request is in flight.
  const rawTier = data?.tier ?? account?.tier;

  const num = (value: number | undefined) => (data ? count(value ?? 0) : '—');
  const money = (value: number | undefined) => (data ? usd(value ?? 0) : '—');

  return (
    <ChartMotion animateEntry={!core.fromCache}>
    <div>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Dashboard</h1>
          <p>Your catalog &middot; placements &middot; messages</p>
        </div>
        {/* Tier colour on the RIM only: the fill and the ink stay admin tokens,
            so the badge holds up in both admin themes. */}
        <span className={styles.tierBadge} style={{ borderColor: tierColorSet(rawTier).base }}>
          {tierLabel(rawTier)} tier
        </span>
      </div>

      <div className={styles.stats}>
        <Tile
          label="Total Parts"
          value={num(data?.total_parts)}
          hint="parts tied to your company"
          toneClass={styles.toneGreen}
        />
        <Tile
          label="Active Sponsorships"
          value={num(data?.active_sponsorships)}
          hint="placements running now"
          toneClass={styles.tonePurple}
        />
        <Tile
          label="Monthly Sponsor Spend"
          value={money(data?.monthly_spend)}
          hint="what those placements cost you each month"
          toneClass={styles.toneGold}
        />
        <Tile
          label="Unread Messages"
          value={num(data?.unread_messages)}
          hint="waiting in your inbox"
          toneClass={styles.toneBlue}
        />
      </div>

      {!loading && !linked && (
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <div className={styles.emptyChart}>
              <strong>Your account is not linked to a company yet.</strong>
              <span>
                Circuit Center staff link an account to the distributor or manufacturer it
                belongs to. Until then these totals stay at zero and the panels below stay
                empty.
              </span>
            </div>
          </div>
        </div>
      )}

      <div className={styles.aOne}>
        <KpiPanel />
      </div>

      <div className={styles.aEven}>
        <ReferralClicksPanel data={referrals} loading={loading} />
        <RevenuePanel data={revenue} loading={loading} />
      </div>

      {/* The staff board pairs its sponsor mix with site traffic in exactly
          this row; the customer board keeps the pairing so the two consoles
          read the same way. */}
      <div className={styles.aEven}>
        <SponsorMixPanel mix={mix} loading={loading} canSponsor={isSupplier} />
        <TrafficPanel data={referrals} loading={loading} />
      </div>

      <div className={styles.aOne}>
        <BookOfBusinessPanel book={book} loading={loading} />
      </div>

      <div className={styles.aWide}>
        <OperatingCostsPanel costs={costs} loading={loading} />
        <LeadsPanel summary={leads} loading={loading} />
      </div>

      <div className={styles.aOne}>
        <EngagementPanel />
      </div>

      <div className={styles.aTwo}>
        <ActivityPanel events={activity} loading={loading} />
        <ImportQueuePanel feed={feed} loading={loading} />
      </div>
    </div>
    </ChartMotion>
  );
}
