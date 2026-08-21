// Visitors by Country — the site-analytics signature panel.
//
// The signature panel of the analytics instrument zone (design pass
// 2026-08-21): the referenced kit's night-indigo ground carrying Circuit
// Center's single-hue GREEN choropleth — the one place the brand color
// burns bright inside the fig's atmosphere. Ramp #245c44→#82f2b2
// re-validated with the dataviz palette script against the zone surface
// #0f1526 (ordinal mode, all checks pass).
//
// Data honesty: country capture is FORWARD-ONLY (ip_hash is one-way, so
// history can never be geolocated). Until data exists the panel says so
// instead of rendering an empty map as if the world sent nobody. The DB-IP
// attribution link is a CC-BY license requirement, not decoration.

import { useEffect, useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import EChart, { registerMapOnce } from '@admin/components/charts/EChart';
import type { AnalyticsData } from '@admin/types/admin';
import { flagEmoji } from './chartKit';
import styles from './ReportsPage.module.scss';

const MAP_NAME = 'world110';
// Ramp validated on the zone surface #0f1526 (.wmCard) — ordinal, all pass.
const RAMP = ['#245c44', '#2f7d5b', '#3fa172', '#57c78c', '#82f2b2'];
const LAND_NO_DATA = '#1a2440';
const BORDER = '#2b3a5e';

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

interface WorldMapPanelProps {
  countries: AnalyticsData['countries'];
  geoTrackedSince: string | null;
  segment: AnalyticsData['segment'];
}

export default function WorldMapPanel({
  countries,
  geoTrackedSince,
  segment,
}: WorldMapPanelProps) {
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import('@admin/components/charts/world-110m.geo.json')
      .then((mod) => {
        if (cancelled) return;
        registerMapOnce(MAP_NAME, (mod as { default: object }).default ?? mod);
        setMapReady(true);
      })
      .catch(() => {
        /* map asset failed to load — the rank list still renders */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Floor 2: prod's day-one state is exactly one country with one view, and
  // a continuous visualMap with min === max degenerates (NaN gradient
  // position). min stays 1; the scale just spans at least 1..2.
  const maxViews = Math.max(2, ...countries.map((c) => c.views));
  const collecting = countries.length === 0;

  const option: EChartsCoreOption = useMemo(
    () => ({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: '#141d36',
        borderColor: '#2b3a63',
        textStyle: { color: '#e8eef9', fontSize: 12 },
        formatter: (p: { name?: string; value?: number }) => {
          const code = p.name ?? '';
          if (!code) return '';
          const v = typeof p.value === 'number' && !Number.isNaN(p.value) ? p.value : 0;
          const row = countries.find((c) => c.code === code);
          const visitors = row ? ` · ${row.visitors} visitor${row.visitors === 1 ? '' : 's'}` : '';
          return `${flagEmoji(code)} ${countryName(code)}<br/>${v} view${v === 1 ? '' : 's'}${visitors}`;
        },
      },
      // In the collecting state the component is OMITTED outright: a mounted
      // visualMap paints every no-data region with its default outOfRange
      // color (theme green), turning an honest empty map into a lie.
      ...(collecting
        ? {}
        : {
            visualMap: {
              show: true,
              type: 'continuous',
              min: 1,
              max: maxViews,
              orient: 'horizontal',
              left: 14,
              bottom: 10,
              itemWidth: 10,
              itemHeight: 90,
              text: [`${maxViews}`, '1'],
              textStyle: { color: '#93a2c4', fontSize: 10 },
              inRange: { color: RAMP },
              outOfRange: { color: LAND_NO_DATA },
            },
          }),
      series: [
        {
          type: 'map',
          map: MAP_NAME,
          nameProperty: 'iso',
          roam: false,
          top: 8,
          bottom: 26,
          left: 8,
          right: 8,
          itemStyle: {
            areaColor: LAND_NO_DATA,
            borderColor: BORDER,
            borderWidth: 0.6,
          },
          emphasis: {
            label: { show: false },
            itemStyle: { areaColor: '#a5f7c6', borderColor: '#d7ffe8' },
          },
          select: { disabled: true },
          data: countries.map((c) => ({ name: c.code, value: c.views })),
        },
      ],
    }),
    [countries, maxViews, collecting],
  );

  const top = countries.slice(0, 8);

  return (
    <div className={`${styles.chartCard} ${styles.chartFull} ${styles.wmCard}`}>
      <div className={styles.chartHead}>
        <h3 className={`${styles.chartTitle} ${styles.wmTitle}`}>Visitors by Country</h3>
        <span className={`${styles.chartSub} ${styles.wmSub}`}>
          {collecting
            ? 'Collecting — country is recorded from today forward'
            : `${segment === 'humans' ? 'Human traffic' : segment === 'bots' ? 'Crawler traffic' : 'All traffic'} by location`}
        </span>
      </div>

      <div className={styles.wmBody} data-collecting={collecting || undefined}>
        <div className={styles.wmMap}>
          {mapReady ? (
            <EChart option={option} style={{ height: 300 }} />
          ) : (
            <div className={styles.wmLoading}>Loading map&hellip;</div>
          )}
          {collecting && (
            <div className={styles.wmCollect}>
              <strong>No located visits yet</strong>
              <p>
                Locations are resolved when a page view lands
                {geoTrackedSince ? ` (since ${geoTrackedSince.slice(0, 10)})` : ''}. Earlier
                history has no location &mdash; stored IPs are one-way hashes.
              </p>
            </div>
          )}
        </div>

        {!collecting && (
          <div className={styles.wmRank}>
            {top.map((c) => (
              <div key={c.code} className={styles.wmRow}>
                <span className={styles.wmFlag} aria-hidden="true">
                  {flagEmoji(c.code)}
                </span>
                <span className={styles.wmName} title={countryName(c.code)}>
                  {countryName(c.code)}
                </span>
                <span className={styles.wmTrack}>
                  <span
                    className={styles.wmFill}
                    style={{ width: `${Math.max(4, (c.views / maxViews) * 100)}%` }}
                  />
                </span>
                <span className={styles.wmVal}>{c.views.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.wmFoot}>
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
          IP Geolocation by DB-IP
        </a>
      </div>
    </div>
  );
}
