// SalesRepsPanel — book of business as a radial cluster graph.
//
// Reps are labelled hubs; their customers sit on concentric tier SHELLS
// around them (Platinum in, Silver out), tier-fixed sizes, divided EVENLY
// per shell (360°/n from 12 o'clock) and coloured by sponsor TIER (the board
// materials). salesForcePhysics makes it alive: drag a name bubble to move
// the whole cluster (children trail with a springy lag), flail a leaf and it
// springs back home. The "Demo" seller is the not-real catch-all (catalog
// distributors + seeded fakes); it collapses to one summary sphere, sits last
// and is dimmed in the legend, and the "Rep book" total excludes it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import type { EChartsType } from 'echarts/core';
import EChart from '@admin/components/charts/EChart';
import { buildSalesForce, type SalesForceGroup } from '@admin/components/charts/options';
import {
  attachSalesForcePhysics,
  type SalesForcePhysicsHandle,
} from '@admin/components/charts/options/salesForcePhysics';
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
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const groups = useMemo(() => buildGroups(reps), [reps]);
  // EVERY cluster collapses to a summary sphere on a plain click (bubble or
  // legend row) — `toggled` XORs against the default state, which is
  // collapsed for the not-real "Demo" bucket and expanded for real reps.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [chart, setChart] = useState<EChartsType | null>(null);
  const physicsRef = useRef<SalesForcePhysicsHandle | null>(null);

  const isCollapsed = useCallback(
    (g: BuiltGroup) => g.demo !== toggled.has(g.name),
    [toggled],
  );
  const toggleGroup = useCallback((name: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const build = useMemo(
    () =>
      buildSalesForce({
        groups: groups.map((g) => ({ ...g, collapsed: isCollapsed(g) })),
        valueFormat: usdCompact,
        emptyMessage: 'No sponsorships assigned to a rep yet.',
      }),
    [groups, isCollapsed],
  );
  const option = build.option;

  const onReady = useCallback((c: EChartsType) => setChart(c), []);

  // (Re)attach the spring layer AFTER each option rebuild. Effects run
  // child-first, so EChart has already applied the new option (notMerge) by
  // the time this runs; cleanup-first detaches the previous attachment.
  // attachSalesForcePhysics is StrictMode/dispose-safe (inert on a disposed
  // chart; dispose() is idempotent and kills its rAF + listeners).
  useEffect(() => {
    if (!chart) return;
    const physics = attachSalesForcePhysics(chart, build.layout);
    physicsRef.current = physics;
    return () => {
      physicsRef.current = null;
      physics.dispose();
    };
  }, [chart, build]);

  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        // A "click" that was actually a drag (pointer travelled) must not
        // toggle the cluster — the user was moving the sphere.
        if (physicsRef.current?.wasDragClick()) return;
        const d = (params as { data?: { groupName?: string; kind?: string } })?.data;
        if (d?.groupName && (d.kind === 'summary' || d.kind === 'hub')) {
          toggleGroup(d.groupName);
        }
      },
    }),
    [toggleGroup],
  );

  // The real book excludes the Demo catch-all — its attribution is not real.
  const repBook = groups.filter((g) => !g.demo).reduce((sum, g) => sum + g.total, 0);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Book of business</h3>
          <p className={styles.panelSub}>
            By sales rep &middot; rings = tier &middot; drag a name bubble &middot; click one to
            collapse/expand
          </p>
        </div>
        <Link to={consolePath('/admin/sponsors')} className={styles.panelLink}>
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
              <EChart option={option} onEvents={onEvents} onReady={onReady} style={{ height: 400 }} />
            </div>
            <ul className={`${styles.repLegend} ${styles.bookLegend}`}>
              {groups.map((g) => (
                <li
                  key={g.name}
                  className={g.demo ? `${styles.repRow} ${styles.repRowDemo}` : styles.repRow}
                  onClick={() => toggleGroup(g.name)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className={styles.repSwatch} style={{ background: g.color }} />
                  <span className={styles.repName}>
                    {g.name}
                    {isCollapsed(g) ? ' ▸' : ' ▾'}
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
