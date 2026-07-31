// SalesRepsPanel — book of business as a radial cluster graph.
//
// Reps are labelled hubs; their customers are leaf nodes divided EVENLY
// around them (360°/n spokes from 12 o'clock), sized by monthly value and
// coloured by sponsor TIER (the board materials). The "Demo" seller is the
// not-real catch-all (catalog distributors + seeded fakes); it collapses to
// one summary sphere, sits last and is dimmed in the legend, and the
// "Rep book" total excludes it.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import EChart from '@admin/components/charts/EChart';
import { salesForceOption, type SalesForceGroup } from '@admin/components/charts/options';
import { CHART_NEUTRAL, CHART_SERIES } from '@admin/components/charts/chartTheme';
import type { SalesRep } from '@admin/types/admin';
import { usd, usdCompact } from './format';
import styles from '../DashboardPage.module.scss';

// Hub / cluster colours for the reps (leaves stay tier-coloured). Gold is
// skipped — it now reads as the Gold TIER. "Demo" is the neutral slate.
const HUB_COLORS = [CHART_SERIES[0], CHART_SERIES[1], CHART_SERIES[3]];

function isDemoSeller(name: string): boolean {
  return name.trim().toLowerCase() === 'demo';
}

interface SalesRepsPanelProps {
  reps: SalesRep[];
  loading: boolean;
}

interface BuiltGroup extends SalesForceGroup {
  accounts: number;
  demo: boolean;
}

function buildGroups(reps: readonly SalesRep[]): BuiltGroup[] {
  // Real reps first (by book, desc); the Demo catch-all always sits last.
  const ordered = [...reps].sort((a, b) => {
    const ad = isDemoSeller(a.name) ? 1 : 0;
    const bd = isDemoSeller(b.name) ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (Number(b.total) || 0) - (Number(a.total) || 0);
  });
  let colorIndex = 0;
  return ordered.map((rep) => {
    const demo = isDemoSeller(rep.name);
    return {
      name: rep.name,
      demo,
      color: demo ? CHART_NEUTRAL : HUB_COLORS[colorIndex++ % HUB_COLORS.length],
      total: Number(rep.total) || 0,
      accounts: rep.customers.length,
      children: rep.customers.map((c) => ({
        label: c.company,
        value: Number(c.amount) || 0,
        tier: c.tier,
      })),
    };
  });
}

export default function SalesRepsPanel({ reps, loading }: SalesRepsPanelProps) {
  const groups = useMemo(() => buildGroups(reps), [reps]);
  const [demoOpen, setDemoOpen] = useState(false);

  const option = useMemo(
    () =>
      salesForceOption({
        // The not-real "Demo" bucket collapses to ONE summary sphere (click to
        // expand) unless the user has opened it — that alone de-clutters the
        // graph; reps then cluster naturally in the free force layout.
        groups: groups.map((g) => ({ ...g, collapsed: g.demo && !demoOpen })),
        valueFormat: usdCompact,
        emptyMessage: 'No sponsorships assigned to a rep yet.',
      }),
    [groups, demoOpen],
  );

  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const d = (params as { data?: { groupName?: string; kind?: string } })?.data;
        if (d && isDemoSeller(d.groupName ?? '') && (d.kind === 'summary' || d.kind === 'hub')) {
          setDemoOpen((open) => !open);
        }
      },
    }),
    [],
  );

  // The real book excludes the Demo catch-all — its attribution is not real.
  const repBook = groups.filter((g) => !g.demo).reduce((sum, g) => sum + g.total, 0);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Book of business</h3>
          <p className={styles.panelSub}>
            By sales rep &middot; area = monthly value &middot; click Demo to expand
          </p>
        </div>
        <Link to="/admin/sponsors" className={styles.panelLink}>
          Sponsors &rarr;
        </Link>
      </div>
      <div className={styles.panelBody}>
        {groups.length === 0 ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading reps…'
            ) : (
              <>
                <strong>No rep assignments yet.</strong>
                <span>
                  Set <em>Sold by</em> on a sponsorship and its value shows up here.
                </span>
              </>
            )}
          </div>
        ) : (
          <div className={styles.bookWrap}>
            <div className={styles.bookChart}>
              <EChart option={option} onEvents={onEvents} style={{ height: 400 }} />
            </div>
            <ul className={`${styles.repLegend} ${styles.bookLegend}`}>
              {groups.map((g) => (
                <li
                  key={g.name}
                  className={g.demo ? `${styles.repRow} ${styles.repRowDemo}` : styles.repRow}
                  onClick={g.demo ? () => setDemoOpen((open) => !open) : undefined}
                  style={g.demo ? { cursor: 'pointer' } : undefined}
                >
                  <span className={styles.repSwatch} style={{ background: g.color }} />
                  <span className={styles.repName}>
                    {g.name}
                    {g.demo ? (demoOpen ? ' ▾' : ' ▸') : ''}
                  </span>
                  <span className={styles.repCount}>
                    {g.accounts} {g.accounts === 1 ? 'account' : 'accounts'}
                  </span>
                  <span className={styles.repTotal}>{usd(g.total)}</span>
                </li>
              ))}
              <li className={`${styles.repRow} ${styles.repRowTotal}`}>
                <span className={styles.repName}>Rep book</span>
                <span className={styles.repCount} />
                <span className={styles.repTotal}>{usd(repBook)}</span>
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
