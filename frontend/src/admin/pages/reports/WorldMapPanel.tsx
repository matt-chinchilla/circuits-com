// Visitors by Country — the site-analytics signature panel.
//
// The signature panel of the analytics instrument zone (design pass
// 2026-08-21): the referenced kit's night-indigo ground carrying a THERMAL
// choropleth — an inferno slice, cool-dark to hot, which is the palette a
// reader already associates with a heat map. It replaced the original
// single-hue green ramp on 2026-08-30 (owner feedback: an all-green heat map
// does not read as heat). The ramp lives in viewershipBins.ts; the two option
// objects it colors live in mapOptions.ts. This file is the state machine,
// the interactions and the DOM around them.
//
// Data honesty: country capture is FORWARD-ONLY (ip_hash is one-way, so
// history can never be geolocated). Until data exists the panel says so
// instead of rendering an empty map as if the world sent nobody. The DB-IP
// attribution link is a CC-BY license requirement, not decoration.
//
// ── Two views, one card (2026-08-30) ───────────────────────────────────────
// Clicking the United States drills into a state choropleth with a city-dot
// layer. The two views differ structurally, not just in data — mapOptions.ts
// carries that story, since it is the file that builds the difference. Each
// view also carries its OWN collecting state: state-level capture started
// later than country capture, so a card full of countries can still have
// nothing to say about states.
//
// The US view zooms: click a state to frame it (usZoom.ts does the fit math),
// wheel/drag to roam free, "Reset view" to come home. Zoom is applied
// imperatively (merge-setOption on the captured instance) because the React
// option prop is applied notMerge and would stomp the user's roam.
//
// ── The city intel card (2026-08-30) ───────────────────────────────────────
// Clicking a city dot opens ONE popover anchored at the click, inside the map
// box, reporting who that town actually was: views + visitors, its top
// networks, its device split and when it was last seen. Those fields are
// OPTIONAL on the payload, so the same panel renders against an API that
// predates them — absent sections are simply not drawn. The Top-towns rows
// are buttons opening the same card in a pinned corner slot, because a
// canvas dot is not a keyboard target.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { EChartsType } from 'echarts/core';
import EChart from '@admin/components/charts/EChart';
// Importing this module is what pulls MapChart + the geo coordinate system +
// ScatterChart into the bundle — it is scoped to this panel on purpose, so no
// other admin chart page pays for the map renderer.
import { registerMapOnce } from '@admin/components/charts/echartsMap';
import type { AnalyticsData } from '@admin/types/admin';
import { countryName, flagEmoji } from '@admin/services/country';
import { albersUsaProject } from './mapProjections';
import { binColorFor, buildBins } from './viewershipBins';
import {
  cityLabel,
  clampCardPosition,
  deviceSplitLabel,
  formatLastSeen,
  networkLines,
  viewsVisitorsLabel,
} from './cityIntel';
import {
  MAP_BOX,
  MAP_NAME,
  US_MAP_NAME,
  buildUsOption,
  buildWorldOption,
} from './mapOptions';
import type { CityPoint, UsCityRow, UsStateRow } from './mapOptions';
import { featureBounds, viewForBounds } from './usZoom';
import type { BBox } from './usZoom';
import styles from './ReportsPage.module.scss';

const CITY_R_MIN = 4;
// 11, not 14: at the auto-fit the Northeast corridor overlaps into a blob at
// 14 (measured 2026-08-30); zooming in is what earns the detail back.
const CITY_R_MAX = 11;

/** How many rows the rank rail shows beside the map, either view. */
const RANK_ROWS = 8;

type MapView = 'world' | 'us';

/** The open intel card. `at` is a position in pixels inside `.wmMap`; null is
 *  the pinned corner slot the keyboard path uses, which needs no click to
 *  anchor to. */
interface CityIntel {
  row: UsCityRow;
  at: { left: number; top: number } | null;
}

/** The world asset is a faithful mirror of its upstream source, Antarctica
 *  included; the filter lives here rather than in the committed file. */
interface WorldGeoJson {
  type: string;
  features: Array<{ properties?: { iso?: string } }>;
}

type UsGeoJson = Parameters<typeof featureBounds>[0];

/**
 * Both geojson assets load the same way: a cancel-flagged dynamic import
 * whose default export is handed to `onReady`, and whose failure downgrades
 * the panel to its rank rail rather than an eternal "Loading map…". Returns
 * the effect cleanup.
 *
 * `load` is a thunk rather than a specifier so each call site keeps a STATIC
 * `import()` literal — that is what lets Vite split the asset into its own
 * chunk at all.
 */
function loadMapAsset<T>(
  load: () => Promise<unknown>,
  onReady: (asset: T) => void,
  onError: () => void,
): () => void {
  let cancelled = false;
  load()
    .then((mod) => {
      if (cancelled) return;
      onReady(((mod as { default?: T }).default ?? mod) as T);
    })
    .catch(() => {
      if (!cancelled) onError();
    });
  return () => {
    cancelled = true;
  };
}

function segmentLabel(segment: AnalyticsData['segment']): string {
  return segment === 'humans' ? 'Human traffic' : segment === 'bots' ? 'Crawler traffic' : 'All traffic';
}

/** Floor 2: prod's day-one state is exactly one country with one view, and a
 *  100%-wide rank bar for a single view overstates it. The bins themselves
 *  need no floor — buildBins(1) is a valid one-piece legend. */
function rankMax(rows: Array<{ views: number }>): number {
  return Math.max(2, ...rows.map((r) => r.views));
}

/** The collecting-state copy. Both views explain the same thing — capture is
 *  forward-only because stored IPs are one-way hashes — and differ only in
 *  what was not captured, so the sentence is built once. */
function collectingCopy(
  isUs: boolean,
  segment: AnalyticsData['segment'],
  since: string | null | undefined,
): { heading: string; body: string } {
  const sinceNote = since ? ` (since ${since.slice(0, 10)})` : '';
  const [subject, noun] = isUs
    ? ['States and towns are', 'state']
    : ['Locations are', 'location'];
  return {
    heading: isUs
      ? `No state-resolved ${segmentLabel(segment).toLowerCase()} yet`
      : 'No located visits yet',
    // The dash is written as an escape, the way cityIntel.ts writes its
    // interpunct: a raw glyph in a TS string gets mangled by edit tooling
    // (CLAUDE.md), and this one used to be a `&mdash;` entity that only
    // worked because it sat in JSX text rather than in a string.
    body: `${subject} resolved when a page view lands${sinceNote}. Earlier history has no ${noun} \u2014 stored IPs are one-way hashes.`,
  };
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
  // A failed geojson chunk must not read as an eternal "Loading map…" — the
  // rank rail still renders, but the box says what actually happened.
  const [mapError, setMapError] = useState(false);
  // True once the CURRENT view has been zoomed — by a state click or a
  // wheel/drag roam — so the "Reset view" pill knows to appear.
  const [zoomed, setZoomed] = useState(false);
  // Bumping this remounts the chart (it is part of the EChart key), and a
  // fresh mount lays the map out at its declared auto-fit — that IS the
  // reset, for both views, with no per-view math. A real dependency the
  // renderer visibly consumes, not a phantom entry in a memo's dep array.
  const [resetNonce, setResetNonce] = useState(0);
  const [intel, setIntel] = useState<CityIntel | null>(null);
  // The live chart instance (captured per mount via onReady; the key={view}
  // remount swaps it) and the states asset's bounding boxes, both consumed
  // imperatively by the zoom handlers. Zoom goes through merge-setOption on
  // the instance rather than the React option: the option prop is applied
  // notMerge, so putting center/zoom there would discard the user's wheel
  // roam on every unrelated re-render.
  const usChartRef = useRef<EChartsType | null>(null);
  const usBoundsRef = useRef<{ byName: Record<string, BBox>; frame: BBox } | null>(null);
  // The intel card's positioning frame and its two focus/hit-test anchors.
  const mapRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Whatever opened the card (a Top-towns button; null for a canvas dot,
  // which is not focusable). A keyboard close hands focus back to it, so
  // reading several towns in a row is not several trips from the top of
  // the page.
  const intelTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(
    () =>
      loadMapAsset<WorldGeoJson>(
        () => import('@admin/components/charts/world-110m.geo.json'),
        (world) => {
          // Antarctica reaches -90°, and on a 300px-tall card that single
          // feature costs a third of the vertical budget to draw a landmass
          // that will never send a page view.
          registerMapOnce(MAP_NAME, {
            ...world,
            features: world.features.filter((f) => f.properties?.iso !== 'AQ'),
          });
          setMapReady(true);
        },
        () => setMapError(true), // the rank list still renders
      ),
    [],
  );

  // The states asset is ~131 kB and most sessions never drill in, so it is
  // fetched on the first click rather than alongside the world.
  useEffect(() => {
    if (view !== 'us' || usMapReady) return;
    return loadMapAsset<UsGeoJson>(
      () => import('@admin/components/charts/us-states-albers.geo.json'),
      (states) => {
        usBoundsRef.current = featureBounds(states);
        registerMapOnce(US_MAP_NAME, states);
        setUsMapReady(true);
      },
      () => setMapError(true), // the rank list still renders
    );
  }, [view, usMapReady]);

  const closeIntel = useCallback((restoreFocus: boolean) => {
    setIntel(null);
    if (restoreFocus && intelTriggerRef.current?.isConnected) {
      intelTriggerRef.current.focus({ preventScroll: true });
    }
    intelTriggerRef.current = null;
  }, []);

  // Dismissal, all four doors at once. `mousedown` rather than `click` is
  // load-bearing: ECharts opens the card on `click`, which fires AFTER
  // mousedown, so clicking a second dot closes the first card and then opens
  // the new one — in that order — instead of the two racing each other.
  useEffect(() => {
    if (!intel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeIntel(true);
    };
    const onDown = (e: MouseEvent) => {
      // `Node.contains(window)` THROWS — narrow before calling it (CLAUDE.md).
      if (e.target instanceof Node && cardRef.current?.contains(e.target)) return;
      closeIntel(false); // a pointer close keeps focus where the user clicked
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [intel, closeIntel]);

  // Move focus into the card so Esc and Tab land somewhere sensible — this is
  // what makes the Top-towns buttons an actual keyboard path rather than a
  // button that opens something unreachable. preventScroll: the card is
  // absolutely positioned inside a panel that must not jump.
  useEffect(() => {
    if (!intel) return;
    closeRef.current?.focus({ preventScroll: true });
  }, [intel]);

  const stateRows: UsStateRow[] = useMemo(() => usStates ?? [], [usStates]);
  const cityRows: UsCityRow[] = useMemo(() => usCities ?? [], [usCities]);

  const maxViews = rankMax(countries);
  const usMaxViews = rankMax(stateRows);

  const worldBins = useMemo(() => buildBins(maxViews), [maxViews]);
  const usBins = useMemo(() => buildBins(usMaxViews), [usMaxViews]);

  const enterUs = useCallback(() => {
    setView('us');
    setZoomed(false); // each view starts at its own auto-fit
  }, []);
  const backToWorld = useCallback(() => {
    setView('world');
    setZoomed(false);
    setIntel(null); // the card belongs to the US view only
  }, []);

  const captureChart = useCallback((chart: EChartsType) => {
    // Both views' instances land here (one per key={view} mount); the
    // click-to-zoom handler only ever runs while the US view is mounted.
    usChartRef.current = chart;
  }, []);

  const resetView = useCallback(() => {
    setResetNonce((n) => n + 1);
    setZoomed(false);
  }, []);

  // World: clicking the US drills in. US: clicking a dot opens its intel card,
  // and clicking any state zooms to it — which is also what un-piles the
  // Northeast city dots, since symbols keep their pixel size while the
  // geography under them expands.
  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const p = params as {
          name?: string;
          seriesType?: string;
          data?: { row?: UsCityRow };
          event?: { offsetX?: number; offsetY?: number };
        } | null;
        if (!p?.name) return;
        if (view === 'world') {
          // Through enterUs, same as the keyboard pill — the raw setView here
          // used to leak a world roam's Reset pill into the fresh US auto-fit.
          if (p.name === 'US') enterUs();
          return;
        }
        if (p.seriesType === 'scatter') {
          // A dot is a place, not a frame: it opens the card, never zooms.
          const row = p.data?.row;
          if (!row) return;
          const box = mapRef.current;
          intelTriggerRef.current = null; // a canvas dot is not focusable
          setIntel({
            row,
            at: clampCardPosition(p.event?.offsetX ?? 0, p.event?.offsetY ?? 0, {
              width: box?.clientWidth ?? 0,
              height: box?.clientHeight ?? 0,
            }),
          });
          return;
        }
        const info = usBoundsRef.current;
        const chart = usChartRef.current;
        const bounds = info?.byName[p.name];
        if (!info || !bounds || !chart || chart.isDisposed()) return;
        const plotW = Math.max(chart.getWidth() - MAP_BOX.left - MAP_BOX.right, 1);
        const plotH = Math.max(chart.getHeight() - MAP_BOX.top - MAP_BOX.bottom, 1);
        chart.setOption({ geo: viewForBounds(bounds, info.frame, plotW, plotH) });
        setZoomed(true);
      },
      // Wheel zoom / drag pan, EITHER view. The event also fires when
      // scaleLimit clamps the gesture to NOTHING (a wheel-down at the zoom
      // floor), and even a clamped roam writes a concrete `center` into the
      // option (measured 2026-08-30) — so the tells are the RESULTING zoom
      // and the event's own pan deltas, never `center != null`. A drag pan
      // carries dx/dy and really moves the view; a clamped wheel carries
      // neither and leaves zoom at the floor.
      georoam: (params: unknown) => {
        const chart = usChartRef.current;
        if (!chart || chart.isDisposed()) return;
        const p = params as { dx?: number; dy?: number } | null;
        const opt = chart.getOption() as {
          geo?: Array<{ zoom?: number }>;
          series?: Array<{ zoom?: number }>;
        };
        const zoom = (view === 'us' ? opt.geo?.[0] : opt.series?.[0])?.zoom ?? 1;
        setZoomed(zoom > 1.0001 || p?.dx != null || p?.dy != null);
      },
    }),
    [view, enterUs],
  );

  const worldOption = useMemo(
    () => buildWorldOption({ countries, bins: worldBins }),
    [countries, worldBins],
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
        name: cityLabel(c),
        value: [xy[0], xy[1], c.views],
        symbolSize: radius * 2,
        // Each dot takes ITS OWN bin's color off the same ladder the states
        // use, so the one piecewise legend under the map explains both layers.
        itemStyle: { color: binColorFor(c.views, usBins) },
        row: c,
      });
    }
    return points;
  }, [cityRows, usBins]);

  const usOption = useMemo(
    () => buildUsOption({ stateRows, cityPoints, bins: usBins }),
    [stateRows, cityPoints, usBins],
  );

  // The option prop is applied notMerge, so ANY rebuild (segment change,
  // data refresh) silently resets a wheel roam — the pill must not outlive
  // the zoom it described. Imperative click-zooms rebuild nothing, so the
  // pill correctly survives them.
  useEffect(() => {
    setZoomed(false);
  }, [worldOption, usOption]);

  // The INTEL_CARD constant is a ceiling estimate; fonts and platform can
  // move the real rendered height, so the card is measured after layout and
  // nudged back inside the map box if any edge escaped. One-shot: once it
  // fits, the correction is zero and the state stops changing.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const box = mapRef.current;
    if (!intel?.at || !card || !box) return;
    const c = card.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const dx = Math.max(0, c.right - (b.right - 8));
    const dy = Math.max(0, c.bottom - (b.bottom - 8));
    if (dx < 1 && dy < 1) return;
    setIntel((cur) =>
      cur?.at
        ? { ...cur, at: { left: Math.max(8, cur.at.left - dx), top: Math.max(8, cur.at.top - dy) } }
        : cur,
    );
  }, [intel]);

  const isUs = view === 'us';
  const canDrill = stateRows.length > 0 || countries.some((c) => c.code === 'US');
  const chartReady = isUs ? usMapReady : mapReady;
  const showingCollecting = isUs ? stateRows.length === 0 : countries.length === 0;
  const collect = collectingCopy(isUs, segment, isUs ? regionTrackedSince : geoTrackedSince);

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
          {zoomed && (
            <button type="button" className={styles.wmCrumb} onClick={resetView}>
              Reset view
            </button>
          )}
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
            ? `Collecting — ${isUs ? 'state' : 'country'} is recorded from today forward`
            : isUs
              ? `${segmentLabel(segment)} by state — click a state to zoom, a town for detail`
              : `${segmentLabel(segment)} by location — scroll to zoom`}
        </span>
      </div>

      <div className={styles.wmBody} data-collecting={showingCollecting || undefined}>
        <div className={styles.wmMap} ref={mapRef}>
          {chartReady ? (
            <EChart
              key={`${view}:${resetNonce}`}
              option={isUs ? usOption : worldOption}
              onEvents={onEvents}
              onReady={captureChart}
              style={{ height: 300 }}
            />
          ) : (
            <div className={styles.wmLoading}>
              {mapError ? 'The map could not load — refresh to try again.' : 'Loading map…'}
            </div>
          )}
          {/* The one scale for both layers, as DOM below the canvas — never
              painted over the geography, whatever the zoom does. */}
          {!showingCollecting && chartReady && (
            <div className={styles.wmLegend}>
              {(isUs ? usBins : worldBins).map((b) => (
                <span key={b.label} className={styles.wmLegendItem}>
                  <span
                    className={styles.wmLegendSwatch}
                    style={{ background: b.color }}
                    aria-hidden="true"
                  />
                  {b.label}
                </span>
              ))}
              <span className={styles.wmLegendUnit}>views</span>
            </div>
          )}
          {isUs && intel && (
            <CityIntelCard
              intel={intel}
              cardRef={cardRef}
              closeRef={closeRef}
              onClose={() => closeIntel(true)}
            />
          )}
          {showingCollecting && (
            <div className={styles.wmCollect}>
              <strong>{collect.heading}</strong>
              <p>{collect.body}</p>
            </div>
          )}
        </div>

        {!showingCollecting && (
          <div className={styles.wmRank}>
            {isUs
              ? stateRows
                  .slice(0, RANK_ROWS)
                  .map((s) => (
                    <RankRow key={s.name} name={s.name} views={s.views} max={usMaxViews} />
                  ))
              : countries.slice(0, RANK_ROWS).map((c) => (
                  <RankRow
                    key={c.code}
                    flag={flagEmoji(c.code)}
                    name={countryName(c.code)}
                    views={c.views}
                    max={maxViews}
                  />
                ))}
            {isUs && cityRows.length > 0 && (
              <div className={styles.wmTowns}>
                <span className={styles.wmTownsTitle}>Towns · {cityRows.length}</span>
                {/* Buttons, not rows: the dots they mirror are canvas pixels,
                    so this list is the only keyboard route to a town's card —
                    which is why it lists EVERY town, scrolling, not a top 6
                    that would leave the rest pointer-only. */}
                <div className={styles.wmTownsList}>
                  {cityRows.map((c, i) => (
                    <button
                      key={`${c.city}|${c.region ?? ''}|${i}`}
                      type="button"
                      className={styles.wmTown}
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        intelTriggerRef.current = e.currentTarget;
                        setIntel({ row: c, at: null });
                      }}
                    >
                      <span className={styles.wmTownName}>{cityLabel(c)}</span>
                      <span className={styles.wmVal}>{c.views.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
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

/** One rank-rail row. The flag column is what separates the two views: the
 *  world rail carries one, the state rail takes the column back. */
function RankRow({
  flag,
  name,
  views,
  max,
}: {
  flag?: string;
  name: string;
  views: number;
  max: number;
}) {
  return (
    <div className={flag === undefined ? `${styles.wmRow} ${styles.wmRowPlain}` : styles.wmRow}>
      {flag !== undefined && (
        <span className={styles.wmFlag} aria-hidden="true">
          {flag}
        </span>
      )}
      <span className={styles.wmName} title={name}>
        {name}
      </span>
      <span className={styles.wmTrack}>
        <span className={styles.wmFill} style={{ width: `${Math.max(4, (views / max) * 100)}%` }} />
      </span>
      <span className={styles.wmVal}>{views.toLocaleString()}</span>
    </div>
  );
}

interface CityIntelCardProps {
  intel: CityIntel;
  cardRef: RefObject<HTMLDivElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** The intel popover. Every section is conditional: this renders correctly
 *  against a payload that carries nothing but `views`, which is exactly what
 *  an API older than the intel fields sends. */
function CityIntelCard({ intel, cardRef, closeRef, onClose }: CityIntelCardProps) {
  const { row, at } = intel;
  const title = cityLabel(row);
  const networks = networkLines(row.networks);
  const devices = deviceSplitLabel(row.devices);
  const lastSeen = formatLastSeen(row.last_seen);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${title} visitor detail`}
      className={at ? styles.wmIntel : `${styles.wmIntel} ${styles.wmIntelPinned}`}
      style={at ? { left: at.left, top: at.top } : undefined}
    >
      <div className={styles.wmIntelHead}>
        <span className={styles.wmIntelTitle}>{title}</span>
        <button
          ref={closeRef}
          type="button"
          className={styles.wmIntelClose}
          onClick={onClose}
          aria-label="Close visitor detail"
        >
          <span aria-hidden="true">&#10005;</span>
        </button>
      </div>

      <div className={styles.wmIntelStat}>{viewsVisitorsLabel(row.views, row.visitors)}</div>

      {networks.length > 0 && (
        <div className={styles.wmIntelSection}>
          <span className={styles.wmIntelLabel}>Networks</span>
          {networks.map((line) => (
            <span key={line} className={styles.wmIntelLine} title={line}>
              {line}
            </span>
          ))}
        </div>
      )}

      {devices && (
        <div className={styles.wmIntelSection}>
          <span className={styles.wmIntelLabel}>Devices</span>
          <span className={styles.wmIntelLine}>{devices}</span>
        </div>
      )}

      {lastSeen && <div className={styles.wmIntelMeta}>Last seen {lastSeen}</div>}
    </div>
  );
}
