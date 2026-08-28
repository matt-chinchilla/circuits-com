// KpiPanel — the panel that replaced Active Suppliers, and the only one on the
// board the customer configures.
//
// It fetches for itself rather than taking data from the shell, because it is
// the one panel that WRITES: the selector PUTs the key and the reply is the
// re-computed panel, so the read and the write are one state. Lifting that
// into the shell would mean either a second fetch after every pick or a shell
// prop that only this panel can invalidate.
//
// Nothing here enumerates the KPIs. `available` is capability-filtered
// server-side and every label is the payload's own, so a sixth KPI needs no
// change in this file (./kpiMeta carries the two facts the wire omits).

import { useEffect, useMemo, useRef, useState } from 'react';
import EChart from '@admin/components/charts/EChart';
import { CHART_SERIES } from '@admin/components/charts/chartTheme';
import { accountApi } from '@admin/services/accountApi';
import type { AccountKpi } from '@admin/types/account';
import { rankedBarOption } from './chartOptions';
import { kpiAxisFormat, kpiChoices, kpiLabel, kpiValueFormat } from './kpiMeta';
import styles from '../../DashboardPage.module.scss';
import own from './CustomerPanels.module.scss';
import './echartsCustomer';

export default function KpiPanel() {
  const [kpi, setKpi] = useState<AccountKpi | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The PUT is event-driven, so it cannot carry an effect's cancel flag. Set
  // true INSIDE the effect (not at declaration): StrictMode tears every effect
  // down and re-runs it, and a mount-only `false` would leave the panel inert.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    accountApi
      .getAccountKpi()
      .then((next) => {
        if (cancelled) return;
        setKpi(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = (key: string) => {
    if (!key || key === kpi?.selected) return;
    setSaving(true);
    setFailed(false);
    accountApi
      .setAccountKpi(key)
      .then((next) => {
        if (!aliveRef.current) return;
        // The reply IS the panel — replacing state with it is what keeps the
        // chart and its heading from disagreeing for a frame.
        setKpi(next);
      })
      .catch(() => {
        // The previous KPI stays on screen and the selector snaps back to it,
        // which is the truth: nothing was saved.
        if (aliveRef.current) setFailed(true);
      })
      .finally(() => {
        if (aliveRef.current) setSaving(false);
      });
  };

  const choices = kpi ? kpiChoices(kpi) : [];
  const selected = kpi?.selected ?? '';
  const points = useMemo(() => kpi?.points ?? [], [kpi]);
  const heading = kpi ? kpiLabel(kpi) : 'Your catalog';

  // Memoized: `EChart` applies a new option identity with `notMerge`, so an
  // unmemoized builder would redraw the whole chart on every parent render.
  const option = useMemo(
    () =>
      rankedBarOption({
        points,
        color: CHART_SERIES[1],
        valueFormat: kpiValueFormat(selected),
        axisFormat: kpiAxisFormat(selected),
      }),
    [points, selected],
  );

  let emptyText = 'Nothing to measure yet — this fills in as parts land in your catalog.';
  if (loading) emptyText = 'Loading…';
  else if (failed && !kpi) emptyText = 'Could not load this chart.';

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>{heading}</h3>
          <p className={styles.panelSub}>
            {failed && kpi
              ? 'That choice could not be saved — showing the previous one.'
              : 'Pick the measure you want on this board'}
          </p>
        </div>
        <select
          className={own.kpiSelect}
          aria-label="Dashboard measure"
          value={selected}
          disabled={saving || choices.length === 0}
          onChange={(e) => choose(e.target.value)}
        >
          {choices.length === 0 ? (
            <option value="">No measures available</option>
          ) : (
            choices.map((choice) => (
              <option key={choice.key} value={choice.key} disabled={!choice.pickable}>
                {choice.label}
              </option>
            ))
          )}
        </select>
      </div>
      <div className={styles.panelBody}>
        {points.length === 0 ? (
          <div className={styles.emptyChart}>
            {loading ? (
              emptyText
            ) : (
              <>
                <strong>{emptyText}</strong>
                <span>
                  Measures are computed from the parts and listings tied to your company.
                </span>
              </>
            )}
          </div>
        ) : (
          <div className={styles.chartFigure}>
            <EChart option={option} style={{ height: 40 + points.length * 30 }} />
          </div>
        )}
      </div>
    </div>
  );
}
