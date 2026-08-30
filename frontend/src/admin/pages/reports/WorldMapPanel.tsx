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
//
// ── Two views, one card (2026-08-30) ───────────────────────────────────────
// Clicking the United States drills into a state choropleth with a city-dot
// layer. The two views differ structurally, not just in data:
//   world — a bare `series-map` over `world110`, naturalEarth1-projected.
//   us    — a `geo` COMPONENT carrying the states, with the choropleth map
//           series bound by `geoIndex` and the city scatter bound by
//           `coordinateSystem: 'geo'`. A scatter cannot address a map series'
//           private coordinate system, so the dots are what force the geo
//           component; the world view is left alone.
// Each view carries its OWN collecting state: state-level capture started
// later than country capture, so a card full of countries can still have
// nothing to say about states.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import EChart from '@admin/components/charts/EChart';
// Importing this module is what pulls MapChart + VisualMapComponent + the geo
// coordinate system + ScatterChart into the bundle — it is scoped to this
// panel on purpose, so no other admin chart page pays for the map renderer.
import { registerMapOnce } from '@admin/components/charts/echartsMap';
import type { AnalyticsData } from '@admin/types/admin';
import { countryName, flagEmoji } from '@admin/services/country';
import {
  albersUsaProject,
  naturalEarth1Project,
  naturalEarth1Unproject,
  usPlanarProject,
  usPlanarUnproject,
} from './mapProjections';
import { buildBins } from './viewershipBins';
import styles from './ReportsPage.module.scss';

const MAP_NAME = 'world110';
const US_MAP_NAME = 'usStatesAlbers';
const LAND_NO_DATA = '#1a2440';
const BORDER = '#2b3a5e';
const HOVER_LAND = '#a5f7c6';
const HOVER_BORDER = '#d7ffe8';
/** The stock underglow amber (`--underglow`), the one non-green hue on the
 *  card. City dots must read as a different KIND of thing from the states
 *  underneath them, and every green is already spoken for by the ramp. */
const CITY_DOT = '#e8c252';
const CITY_DOT_EDGE = '#4a3a0d';
const CITY_R_MIN = 4;
const CITY_R_MAX = 14;

const WORLD_PROJECTION = {
  project: naturalEarth1Project,
  unproject: naturalEarth1Unproject,
};
// Identity, and NOT omitted — see the Y-convention note in mapProjections.ts.
const US_PROJECTION = { project: usPlanarProject, unproject: usPlanarUnproject };

const TOOLTIP_CHROME = {
  backgroundColor: '#141d36',
  borderColor: '#2b3a63',
  textStyle: { color: '#e8eef9', fontSize: 12 },
};

/** Layout shared by both views so the two maps sit in the same box; `bottom`
 *  reserves the piecewise legend's row. */
const MAP_BOX = { top: 8, bottom: 26, left: 8, right: 8 };

const LAND_STYLE = {
  itemStyle: { areaColor: LAND_NO_DATA, borderColor: BORDER, borderWidth: 0.6 },
  emphasis: {
    label: { show: false },
    itemStyle: { areaColor: HOVER_LAND, borderColor: HOVER_BORDER },
  },
  select: { disabled: true },
};

type MapView = 'world' | 'us';

type UsState = NonNullable<AnalyticsData['us_states']>[number];
type UsCity = NonNullable<AnalyticsData['us_cities']>[number];

/** A city already projected into the states asset's planar frame. */
interface CityPoint {
  name: string;
  value: [number, number, number];
  symbolSize: number;
}

/** The world asset is a faithful mirror of its upstream source, Antarctica
 *  included; the filter lives here rather than in the committed file. */
interface WorldGeoJson {
  type: string;
  features: Array<{ properties?: { iso?: string } }>;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function segmentLabel(segment: AnalyticsData['segment']): string {
  return segment === 'humans' ? 'Human traffic' : segment === 'bots' ? 'Crawler traffic' : 'All traffic';
}

interface WorldMapPanelProps {
  countries: AnalyticsData['countries'];
  geoTrackedSince: string | null;
  segment: AnalyticsData['segment'];
  usStates?: AnalyticsData['us_states'];
  usCities?: AnalyticsData['us_cities'];
  regionTrackedSince?: string | null;
}

export default function WorldMapPanel({
  countries,
  geoTrackedSince,
  segment,
  usStates,
  usCities,
  regionTrackedSince,
}: WorldMapPanelProps) {
  const [view, setView] = useState<MapView>('world');
  const [mapReady, setMapReady] = useState(false);
  const [usMapReady, setUsMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import('@admin/components/charts/world-110m.geo.json')
      .then((mod) => {
        if (cancelled) return;
        const world = ((mod as { default?: WorldGeoJson }).default ?? mod) as WorldGeoJson;
        // Antarctica reaches -90°, and on a 300px-tall card that single
        // feature costs a third of the vertical budget to draw a landmass
        // that will never send a page view.
        registerMapOnce(MAP_NAME, {
          ...world,
          features: world.features.filter((f) => f.properties?.iso !== 'AQ'),
        });
        setMapReady(true);
      })
      .catch(() => {
        /* map asset failed to load — the rank list still renders */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The states asset is ~131 kB and most sessions never drill in, so it is
  // fetched on the first click rather than alongside the world.
  useEffect(() => {
    if (view !== 'us' || usMapReady) return;
    let cancelled = false;
    import('@admin/components/charts/us-states-albers.geo.json')
      .then((mod) => {
        if (cancelled) return;
        registerMapOnce(US_MAP_NAME, (mod as { default: object }).default ?? mod);
        setUsMapReady(true);
      })
      .catch(() => {
        /* states asset failed to load — the rank list still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [view, usMapReady]);

  // Floor 2: prod's day-one state is exactly one country with one view, and a
  // 100%-wide rank bar for a single view overstates it. The bins themselves
  // need no floor — buildBins(1) is a valid one-piece legend.
  const maxViews = Math.max(2, ...countries.map((c) => c.views));
  const collecting = countries.length === 0;

  const stateRows: UsState[] = useMemo(() => usStates ?? [], [usStates]);
  const cityRows: UsCity[] = useMemo(() => usCities ?? [], [usCities]);
  const usMaxViews = Math.max(2, ...stateRows.map((s) => s.views));
  const usCollecting = stateRows.length === 0;

  const enterUs = useCallback(() => setView('us'), []);
  const backToWorld = useCallback(() => setView('world'), []);

  // Only the world map is clickable-through; no state drills any further, and
  // no state is named 'US', so the guard doubles as the US view's no-op.
  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const p = params as { name?: string } | null;
        if (p?.name === 'US') setView('us');
      },
    }),
    [],
  );

  const worldOption: EChartsCoreOption = useMemo(
    () => ({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        ...TOOLTIP_CHROME,
        formatter: (p: { name?: string; value?: number }) => {
          const code = p.name ?? '';
          if (!code) return '';
          const v = typeof p.value === 'number' && !Number.isNaN(p.value) ? p.value : 0;
          const row = countries.find((c) => c.code === code);
          const visitors = row ? ` · ${plural(row.visitors, 'visitor')}` : '';
          return `${flagEmoji(code)} ${countryName(code)}<br/>${plural(v, 'view')}${visitors}`;
        },
      },
      // In the collecting state the component is OMITTED outright: a mounted
      // visualMap paints every no-data region with its default outOfRange
      // color (theme green), turning an honest empty map into a lie.
      ...(collecting ? {} : { visualMap: buildVisualMap(maxViews) }),
      series: [
        {
          type: 'map',
          map: MAP_NAME,
          nameProperty: 'iso',
          projection: WORLD_PROJECTION,
          roam: false,
          ...MAP_BOX,
          ...LAND_STYLE,
          data: countries.map((c) => ({ name: c.code, value: c.views })),
        },
      ],
    }),
    [countries, maxViews, collecting],
  );

  const cityPoints: CityPoint[] = useMemo(() => {
    const peak = Math.max(1, ...cityRows.map((c) => c.views));
    const points: CityPoint[] = [];
    for (const c of cityRows) {
      const xy = albersUsaProject([c.lng, c.lat]);
      // A centroid the geo database put offshore (or outside the three albers
      // zones at all) has nowhere honest to sit — drop it rather than clamp it
      // onto a state it does not belong to.
      if (!xy) continue;
      const radius = CITY_R_MIN + (CITY_R_MAX - CITY_R_MIN) * Math.sqrt(c.views / peak);
      points.push({
        name: c.region ? `${c.city}, ${c.region}` : c.city,
        value: [xy[0], xy[1], c.views],
        symbolSize: radius * 2,
      });
    }
    return points;
  }, [cityRows]);

  const usOption: EChartsCoreOption = useMemo(
    () => ({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        ...TOOLTIP_CHROME,
        formatter: (p: {
          seriesType?: string;
          name?: string;
          value?: number | number[];
          data?: { name?: string; value?: number[] };
        }) => {
          const name = p.name ?? '';
          if (!name) return '';
          if (p.seriesType === 'scatter') {
            const views = p.data?.value?.[2] ?? 0;
            return `${name}<br/>${plural(views, 'view')}`;
          }
          const row = stateRows.find((s) => s.name === name);
          if (!row) return `${name}<br/>No visits recorded`;
          return `${name}<br/>${plural(row.views, 'view')} · ${plural(row.visitors, 'visitor')}`;
        },
      },
      // `seriesIndex: 0` scopes the ramp to the choropleth — without it the
      // visualMap also recolors the city dots, which are deliberately amber.
      ...(usCollecting ? {} : { visualMap: { ...buildVisualMap(usMaxViews), seriesIndex: 0 } }),
      geo: {
        map: US_MAP_NAME,
        nameProperty: 'name',
        projection: US_PROJECTION,
        roam: false,
        ...MAP_BOX,
        ...LAND_STYLE,
      },
      series: [
        {
          type: 'map',
          geoIndex: 0,
          data: stateRows.map((s) => ({ name: s.name, value: s.views })),
        },
        {
          type: 'scatter',
          coordinateSystem: 'geo',
          geoIndex: 0,
          symbol: 'circle',
          itemStyle: {
            color: CITY_DOT,
            opacity: 0.85,
            borderColor: CITY_DOT_EDGE,
            borderWidth: 0.8,
          },
          emphasis: { scale: 1.2, itemStyle: { opacity: 1 } },
          label: { show: false },
          data: cityPoints,
        },
      ],
    }),
    [stateRows, cityPoints, usCollecting, usMaxViews],
  );

  const isUs = view === 'us';
  const canDrill = stateRows.length > 0 || countries.some((c) => c.code === 'US');
  const chartReady = isUs ? usMapReady : mapReady;
  const showingCollecting = isUs ? usCollecting : collecting;
  const top = countries.slice(0, 8);
  const topStates = stateRows.slice(0, 8);
  const topTowns = cityRows.slice(0, 6);

  return (
    <div className={`${styles.chartCard} ${styles.chartFull} ${styles.wmCard}`}>
      <div className={styles.chartHead}>
        <div className={styles.wmTitleRow}>
          {isUs && (
            <button type="button" className={styles.wmCrumb} onClick={backToWorld}>
              <span aria-hidden="true">&#8592;</span> World
            </button>
          )}
          <h3 className={`${styles.chartTitle} ${styles.wmTitle}`}>
            {isUs ? 'Visitors by State' : 'Visitors by Country'}
          </h3>
          {/* The canvas click is the discoverable way in, but it is not a
              keyboard one — the entry pill and the back pill share a slot so
              the drill-down is reachable without a pointer. */}
          {!isUs && canDrill && (
            <button type="button" className={styles.wmCrumb} onClick={enterUs}>
              United States <span aria-hidden="true">&#8594;</span>
            </button>
          )}
        </div>
        <span className={`${styles.chartSub} ${styles.wmSub}`}>
          {showingCollecting
            ? isUs
              ? 'Collecting — state is recorded from today forward'
              : 'Collecting — country is recorded from today forward'
            : `${segmentLabel(segment)} by ${isUs ? 'state, with the busiest towns' : 'location'}`}
        </span>
      </div>

      <div className={styles.wmBody} data-collecting={showingCollecting || undefined}>
        <div className={styles.wmMap}>
          {chartReady ? (
            <EChart
              key={view}
              option={isUs ? usOption : worldOption}
              onEvents={onEvents}
              style={{ height: 300 }}
            />
          ) : (
            <div className={styles.wmLoading}>Loading map&hellip;</div>
          )}
          {showingCollecting &&
            (isUs ? (
              <div className={styles.wmCollect}>
                <strong>No state-level visits yet</strong>
                <p>
                  States and towns are resolved when a page view lands
                  {regionTrackedSince ? ` (since ${regionTrackedSince.slice(0, 10)})` : ''}. Earlier
                  history has no state &mdash; stored IPs are one-way hashes.
                </p>
              </div>
            ) : (
              <div className={styles.wmCollect}>
                <strong>No located visits yet</strong>
                <p>
                  Locations are resolved when a page view lands
                  {geoTrackedSince ? ` (since ${geoTrackedSince.slice(0, 10)})` : ''}. Earlier
                  history has no location &mdash; stored IPs are one-way hashes.
                </p>
              </div>
            ))}
        </div>

        {!showingCollecting && !isUs && (
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

        {!showingCollecting && isUs && (
          <div className={styles.wmRank}>
            {topStates.map((s) => (
              <div key={s.name} className={`${styles.wmRow} ${styles.wmRowPlain}`}>
                <span className={styles.wmName} title={s.name}>
                  {s.name}
                </span>
                <span className={styles.wmTrack}>
                  <span
                    className={styles.wmFill}
                    style={{ width: `${Math.max(4, (s.views / usMaxViews) * 100)}%` }}
                  />
                </span>
                <span className={styles.wmVal}>{s.views.toLocaleString()}</span>
              </div>
            ))}
            {topTowns.length > 0 && (
              <div className={styles.wmTowns}>
                <span className={styles.wmTownsTitle}>Top towns</span>
                {topTowns.map((c, i) => (
                  <div key={`${c.city}|${c.region ?? ''}|${i}`} className={styles.wmTown}>
                    <span className={styles.wmTownName}>
                      {c.region ? `${c.city}, ${c.region}` : c.city}
                    </span>
                    <span className={styles.wmVal}>{c.views.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
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

/** The piecewise legend. Sized and positioned to sit in the row `MAP_BOX`
 *  reserves at the bottom of the plot. */
function buildVisualMap(maxViews: number) {
  return {
    show: true,
    type: 'piecewise' as const,
    orient: 'horizontal' as const,
    // Tight on purpose: five pieces with four-digit labels are ~290px wide,
    // and on a phone the stacked card only gives the plot ~256px. The gaps
    // are what keep the last label on-canvas there.
    left: 10,
    bottom: 4,
    itemWidth: 11,
    itemHeight: 11,
    itemGap: 7,
    textGap: 4,
    showLabel: true,
    pieces: buildBins(maxViews),
    outOfRange: { color: LAND_NO_DATA },
    textStyle: { color: '#93a2c4', fontSize: 10 },
  };
}
