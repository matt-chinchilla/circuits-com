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
// ── Three views, one card ──────────────────────────────────────────────────
// Clicking a country drills into its first-level subdivisions with a city-dot
// layer. That drill-down was United-States-only when it shipped (2026-08-30)
// and reaches EVERY country as of the same day: `region`, `city` and the
// centroid were always stamped on every located page view, the US scoping
// lived only in the queries. mapOptions.ts carries the structural story of
// how a country view differs from the world view.
//
// Each view also carries its OWN collecting state: region-level capture
// started later than country capture, so a card full of countries can still
// have nothing to say about a country's regions.
//
// ── What varies between countries, and what does not ───────────────────────
// The United States keeps its pre-projected AlbersUSA asset — Alaska and
// Hawaii are inset INTO that geometry, and reprojecting it would scatter them
// back across the Pacific — and its regions ride along inside
// /dashboard/analytics, so the landing drill-down opens with no round trip.
// Every other country lazy-loads its own Natural Earth admin-1 asset
// (@admin/components/charts/admin1) and fetches /dashboard/geo/{code}.
//
// Beyond those two, everything is shared: the bins, the ramp, the city dots,
// the intel card, click-a-region zoom, the rank rail. The one genuinely new
// piece is the NAME JOIN — DB-IP writes one English subdivision label and
// Natural Earth carries several spellings at its own admin level — and it
// lives in regionJoin.ts, measured against the real database.
//
// The view zooms: click a region to frame it (usZoom.ts does the fit math),
// wheel/drag to roam free, "Reset view" to come home. Zoom is applied
// imperatively (merge-setOption on the captured instance) because the React
// option prop is applied notMerge and would stomp the user's roam.
//
// ── The density heat map (2026-08-30) ──────────────────────────────────────
// A THIRD view, and the only one that is not ECharts: a real Leaflet slippy
// map (tiles, labels, roads) under a blurred blue->red density layer, which
// is the look the owner asked for. It lives in HeatMapView.tsx behind the
// same cancel-flagged dynamic import the geojson assets use, so its ~163 kB
// of Leaflet is only fetched by someone who opens it. It speaks its own
// visual language on purpose — see that file — which is why the bin legend
// under the map is hidden while it is up.
//
// It is NOT a lesser view. It used to be: it painted anonymous points, so it
// could be looked at and not asked anything, while every piece of reporting
// depth lived in the choropleth. Owner call, 2026-08-30 — "having those
// functionalities be fully-separated in the 2 maps feels strange" — so the
// density layer now reads IDENTIFIED towns (GET /dashboard/towns) and carries
// the same intel card, the same towns list and the same keyboard route as the
// drill-down. All three views open one card from one component.
//
// ── The city intel card (2026-08-30) ───────────────────────────────────────
// Clicking a city dot — or a heat blob — opens ONE popover anchored at the
// click, inside the map box, reporting who that town actually was: views +
// visitors, its top networks, its device split and when it was last seen.
// Those fields are OPTIONAL on the payload, so the same panel renders against
// an API that predates them — absent sections are simply not drawn. The
// Top-towns rows are buttons opening the same card in a pinned corner slot,
// because neither a canvas dot nor a heat blob is a keyboard target.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode, RefObject } from 'react';
import type { EChartsType } from 'echarts/core';
import EChart from '@admin/components/charts/EChart';
// Importing this module is what pulls MapChart + the geo coordinate system +
// ScatterChart into the bundle — it is scoped to this panel on purpose, so no
// other admin chart page pays for the map renderer.
import { registerMapOnce } from '@admin/components/charts/echartsMap';
import { ADMIN1_COUNTRIES, loadAdmin1 } from '@admin/components/charts/admin1';
import type { Admin1Feature } from '@admin/components/charts/admin1';
import { adminApi } from '@admin/services/adminApi';
import type { AnalyticsData, GeoCityRow, GeoRegionRow } from '@admin/types/admin';
import { countryName, flagEmoji } from '@admin/services/country';
import { focusPlan, type LocationFocus } from './locationFocus';
import { albersUsaProject } from './mapProjections';
import { binColorFor, buildBins } from './viewershipBins';
import {
  cityLabel,
  clampCardPosition,
  deviceSplitLabel,
  formatLastSeen,
  networkLines,
  townKey,
  viewsVisitorsLabel,
} from './cityIntel';
import {
  COUNTRY_PROJECTION,
  MAP_NAME,
  US_MAP_NAME,
  US_PROJECTION,
  WORLD_FRAME_ASPECT,
  buildCountryOption,
  buildLabelLayer,
  buildWorldOption,
  focusBeacon,
} from './mapOptions';
import type { CityPoint, RegionPaint } from './mapOptions';
import { buildRegionIndex, resolveRegions } from './regionJoin';
import { US_STATE_LABELS } from './stateLabels';
import { featureBounds, frameAspect, unionBounds, viewForBounds } from './usZoom';
import type { BBox } from './usZoom';
import type { HeatMapViewProps } from './HeatMapView';
import { heatLegendTicks } from './heatWeights';
import styles from './ReportsPage.module.scss';

const CITY_R_MIN = 4;
// 11, not 14: at the auto-fit the Northeast corridor overlaps into a blob at
// 14 (measured 2026-08-30); zooming in is what earns the detail back.
const CITY_R_MAX = 11;

/** How many rows the rank rail shows beside the map, either view. */
const RANK_ROWS = 8;

/** The United States is the one country whose geometry is pre-projected and
 *  whose detail arrives inside the analytics payload. Named rather than
 *  spelled inline so every place that special-cases it is greppable. */
const US = 'US';

/**
 * Whether an intel card may be ANCHORED to the click that opened it.
 *
 * It may not on a phone. Measured at 390px: the card is 216x211 inside a
 * 336x300 map box — 45% of the map — so wherever it is anchored it hides the
 * place it is describing, and there is no position inside the box that is not
 * "over the map". At that width every card opens in the pinned slot instead,
 * which the SCSS docks BELOW the map where a whole column is going spare.
 *
 * Read at open time rather than tracked as state: a viewport that crosses
 * this boundary while a card happens to be open is not worth a resize
 * listener, and the next open gets it right.
 */
function anchoredCards(): boolean {
  return window.matchMedia?.(`(min-width: ${820 + 1}px)`).matches ?? true;
}

type MapView = 'world' | 'country' | 'heat';

/** The open intel card. `at` is a position in pixels inside `.wmMap`; null is
 *  the pinned corner slot the keyboard path uses, which needs no click to
 *  anchor to. */
interface CityIntel {
  row: GeoCityRow;
  at: { left: number; top: number } | null;
}

/** The world asset is a faithful mirror of its upstream source, Antarctica
 *  included; the filter lives here rather than in the committed file. */
interface WorldGeoJson {
  type: string;
  features: Array<{ properties?: { iso?: string } }>;
}

/** Any admin-1 asset, ours or the pre-projected US one. The US file carries
 *  only `name`, which is all the join needs from it — its state names are
 *  DB-IP's state names, exactly (measured: all 30 recorded, see
 *  regionJoin.test.ts). */
interface RegionGeoJson {
  features: Admin1Feature[];
}

/** Everything a country view needs from its geometry, resolved once when the
 *  asset lands: which country it belongs to, the ECharts map name it was
 *  registered under, the projection the geo component will use, the name
 *  index the join reads, and per-feature bounding boxes IN PROJECTED SPACE
 *  for the click-to-zoom fit. */
interface CountryShapes {
  code: string;
  mapName: string;
  projection: typeof US_PROJECTION;
  index: ReturnType<typeof buildRegionIndex>;
  bounds: { byName: Record<string, BBox>; frame: BBox };
}

/** One country's detail as fetched. Held with its code so a late response for
 *  a country the reader has already left cannot paint the new one. */
interface CountryDetail {
  code: string;
  regions: GeoRegionRow[];
  cities: GeoCityRow[];
  regionTrackedSince: string | null;
}

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
 *  what was not captured, so the sentence is built once. `noun` is the word
 *  for a subdivision: a state in the US, a region anywhere else. */
function collectingCopy(
  noun: string | null,
  segment: AnalyticsData['segment'],
  since: string | null | undefined,
): { heading: string; body: string } {
  const sinceNote = since ? ` (since ${since.slice(0, 10)})` : '';
  const [subject, thing] = noun
    ? [`${noun[0].toUpperCase()}${noun.slice(1)}s and towns are`, noun]
    : ['Locations are', 'location'];
  return {
    heading: noun
      ? `No ${noun}-resolved ${segmentLabel(segment).toLowerCase()} yet`
      : 'No located visits yet',
    // The dash is written as an escape, the way cityIntel.ts writes its
    // interpunct: a raw glyph in a TS string gets mangled by edit tooling
    // (CLAUDE.md), and this one used to be a `&mdash;` entity that only
    // worked because it sat in JSX text rather than in a string.
    body: `${subject} resolved when a page view lands${sinceNote}. Earlier history has no ${thing} \u2014 stored IPs are one-way hashes.`,
  };
}

interface WorldMapPanelProps {
  countries: AnalyticsData['countries'];
  geoTrackedSince: string | null;
  segment: AnalyticsData['segment'];
  /** The page's own window, so a drill-down fetch describes the same visits
   *  the world map above it is already drawing. */
  days: number;
  usStates?: AnalyticsData['us_states'];
  usCities?: AnalyticsData['us_cities'];
  /** Countries with at least one region-stamped view in this window. A
   *  country outside it must not offer a drill-down — clicking it would open
   *  an empty choropleth the reader cannot tell from a slow one. Absent on an
   *  API that predates it, which degrades to "the US only", the behaviour
   *  before every country drilled in. */
  regionCountries?: string[];
  regionTrackedSince?: string | null;
  /** How many identified towns the density view would draw. A COUNT, not the
   *  rows — the rows are fetched with that view's Leaflet chunk. Absent on an
   *  API that predates it, which simply does not offer the view. */
  locatedTowns?: number;
  /** "Show me this place" — raised by a location click in the Visiting
   *  Organizations panel below and routed here by the page. Acted on in
   *  WHICHEVER view is open, deliberately: the reader clicked while looking
   *  at one map, and switching them to the other one would answer a question
   *  they did not ask. The `nonce` is what lets the same location be clicked
   *  twice; see `locationFocus.ts`. */
  focus?: LocationFocus | null;
}

export default function WorldMapPanel({
  countries,
  geoTrackedSince,
  segment,
  days,
  usStates,
  usCities,
  regionCountries,
  regionTrackedSince,
  locatedTowns = 0,
  focus = null,
}: WorldMapPanelProps) {
  const [view, setView] = useState<MapView>('world');
  /** The country the drill-down is showing; null while `view` is not
   *  'country'. ISO alpha-2, straight off the world asset's `iso` property. */
  const [country, setCountry] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [shapes, setShapes] = useState<CountryShapes | null>(null);
  const [detail, setDetail] = useState<CountryDetail | null>(null);
  // Which VIEW's asset failed to load, if any. Scoped rather than a single
  // boolean: with one flag a country whose chunk failed left the world view
  // claiming the same failure after the reader backed out of it, and a world
  // failure was silently cleared by drilling in. A failed chunk must not read
  // as an eternal "Loading map…" either — the rank rail still renders, but
  // the box says what actually happened, for the view it happened in.
  const [mapError, setMapError] = useState<MapView | null>(null);
  // True once the CURRENT view has been zoomed — by a region click or a
  // wheel/drag roam — so the "Reset view" pill knows to appear.
  const [zoomed, setZoomed] = useState(false);
  // Bumping this remounts the chart (it is part of the EChart key), and a
  // fresh mount lays the map out at its declared auto-fit — that IS the
  // reset, for both views, with no per-view math. A real dependency the
  // renderer visibly consumes, not a phantom entry in a memo's dep array.
  const [resetNonce, setResetNonce] = useState(0);
  const [intel, setIntel] = useState<CityIntel | null>(null);
  // The density view's component, fetched on the first visit to it. Held as
  // state rather than reached through React.lazy so a failed chunk lands in
  // the SAME degradation the geojson assets already have — the box says what
  // happened and the rank rail keeps working — instead of throwing to the
  // route's error boundary and taking the whole Reports page with it.
  const [HeatView, setHeatView] = useState<ComponentType<HeatMapViewProps> | null>(null);
  // The density view's own rows, fetched with its Leaflet chunk. Held with
  // the window they describe so a stale window's towns cannot paint a new one.
  const [towns, setTowns] = useState<{ days: number; segment: string; rows: GeoCityRow[] } | null>(
    null,
  );
  // Bumped only when a card is opened from the KEYBOARD towns list, which is
  // the one case where the density map should fly to the town. A map click
  // must not yank the view out from under the cursor that made it.
  const [focusNonce, setFocusNonce] = useState(0);
  /** The last `focus.nonce` this panel acted on — see the focus effect. */
  const handledFocusRef = useRef(focus?.nonce ?? 0);
  // The live chart instance (captured per mount via onReady; the key={view}
  // remount swaps it), consumed imperatively by the zoom handlers. Zoom goes
  // through merge-setOption on the instance rather than the React option: the
  // option prop is applied notMerge, so putting center/zoom there would
  // discard the user's wheel roam on every unrelated re-render.
  const chartRef = useRef<EChartsType | null>(null);
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
        () => setMapError('world'), // the rank list still renders
      ),
    [],
  );

  // The drilled-into country's outlines. Most sessions never drill in, and no
  // session drills into more than a few countries, so geometry is fetched on
  // the click that needs it — the US asset is ~131 kB and a Natural Earth
  // country is ~18 kB (median, measured).
  useEffect(() => {
    if (view !== 'country' || !country || shapes?.code === country) return;
    const isUs = country === US;
    return loadMapAsset<RegionGeoJson>(
      () =>
        isUs ? import('@admin/components/charts/us-states-albers.geo.json') : loadAdmin1(country),
      (asset) => {
        const projection = isUs ? US_PROJECTION : COUNTRY_PROJECTION;
        // One registered name per country; `registerMapOnce` makes a revisit
        // free. The US keeps its historical name so nothing else has to move.
        const mapName = isUs ? US_MAP_NAME : `admin1:${country}`;
        registerMapOnce(mapName, asset);
        setShapes({
          code: country,
          mapName,
          projection,
          index: buildRegionIndex(asset.features),
          // In PROJECTED space, with the very function the geo component
          // uses: a box measured in raw degrees would describe a rectangle
          // the renderer never draws, and the fitted zoom would be wrong by
          // exactly the projection's own distortion.
          bounds: featureBounds(asset, projection.project),
        });
      },
      () => setMapError('country'), // the rank list still renders
    );
  }, [view, country, shapes]);

  // The drilled-into country's numbers. The US ships inside the analytics
  // payload already (it is the landing drill-down), so only the rest of the
  // world costs a request — and it is cancel-flagged, because `days` and
  // `segment` change from buttons a reader can click faster than a response
  // returns.
  useEffect(() => {
    if (view !== 'country' || !country || country === US) return;
    if (detail?.code === country) return;
    let cancelled = false;
    adminApi
      .getCountryGeo(country, days, segment)
      .then((payload) => {
        if (cancelled) return;
        setDetail({
          code: payload.country,
          regions: payload.regions,
          cities: payload.cities,
          regionTrackedSince: payload.region_tracked_since,
        });
      })
      .catch(() => {
        if (!cancelled) setMapError('country'); // the rank rail has nothing to show either
      });
    return () => {
      cancelled = true;
    };
  }, [view, country, days, segment, detail]);

  // A window or segment change invalidates a fetched country, the same way it
  // rebuilds every other number on the page. Dropping it here rather than
  // keying the fetch effect on it keeps ONE fetch per (country, window).
  useEffect(() => {
    setDetail(null);
  }, [days, segment]);

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

  const isUsView = country === US;
  const dataReady = isUsView || detail?.code === country;
  const regionRows: GeoRegionRow[] = useMemo(() => {
    if (view !== 'country') return [];
    if (isUsView) return usStates ?? [];
    return detail?.code === country ? detail.regions : [];
  }, [view, isUsView, usStates, detail, country]);
  const cityRows: GeoCityRow[] = useMemo(() => {
    if (view !== 'country') return [];
    if (isUsView) return usCities ?? [];
    return detail?.code === country ? detail.cities : [];
  }, [view, isUsView, usCities, detail, country]);

  // Global, not country-scoped: the density layer draws every located town.
  const heatRows: GeoCityRow[] = useMemo(
    () => (towns && towns.days === days && towns.segment === segment ? towns.rows : []),
    [towns, days, segment],
  );
  // The density view's gradient key: the window's decades read back as tick
  // labels, off the same ladder that scales the weights. Empty for a
  // sub-decade window, which hides the key — there is no ladder to explain.
  const heatTicks = useMemo(
    () => heatLegendTicks(Math.max(1, ...heatRows.map((t) => t.views))),
    [heatRows],
  );

  // Leaflet + leaflet.heat + leaflet.css, on the first visit to the density
  // view and never before — the same reasoning as the country assets above,
  // at roughly the same weight. A window with nothing located is not worth the
  // fetch either, and cannot reach this view anyway (the entry pill is gated
  // on the same count).
  useEffect(() => {
    if (view !== 'heat' || HeatView || locatedTowns === 0) return;
    return loadMapAsset<ComponentType<HeatMapViewProps>>(
      () => import('./HeatMapView'),
      (mod) => setHeatView(() => mod),
      () => setMapError('heat'), // the rank list still renders
    );
  }, [view, HeatView, locatedTowns]);

  // The density view's rows, fetched beside that chunk and on the same terms:
  // it is the whole world's towns WITH their visitor intel (measured 278 rows
  // / 13.7 kB gzipped), which is a third of the Leaflet bytes landing next to
  // it — and it is what lets a click on a blob open a real card with no second
  // request. Cancel-flagged, because `days` and `segment` change from buttons.
  useEffect(() => {
    if (view !== 'heat' || locatedTowns === 0) return;
    if (towns && towns.days === days && towns.segment === segment) return;
    let cancelled = false;
    adminApi
      .getTowns(days, segment)
      .then((payload) => {
        if (!cancelled) setTowns({ days, segment, rows: payload.towns });
      })
      .catch(() => {
        if (!cancelled) setMapError('heat'); // the rank rail still renders
      });
    return () => {
      cancelled = true;
    };
  }, [view, days, segment, towns, locatedTowns]);

  const maxViews = rankMax(countries);
  const regionMaxViews = rankMax(regionRows);

  const worldBins = useMemo(() => buildBins(maxViews), [maxViews]);
  const regionBins = useMemo(() => buildBins(regionMaxViews), [regionMaxViews]);

  /** Which countries the reader may open. Falls back to the United States
   *  alone against an API that does not report the set — that is exactly the
   *  behaviour before every country drilled in. */
  const drillable = useMemo(() => {
    if (regionCountries) return new Set(regionCountries);
    return new Set(countries.some((c) => c.code === US) ? [US] : []);
  }, [regionCountries, countries]);

  const enterCountry = useCallback((code: string) => {
    setView('country');
    setCountry(code);
    setZoomed(false); // each view starts at its own auto-fit
    setIntel(null);
    setMapError((e) => (e === 'country' ? null : e)); // it belonged to the last country
  }, []);
  const enterHeat = useCallback(() => {
    setView('heat');
    setZoomed(false);
    setIntel(null); // a card belongs to the view that opened it
    setMapError((e) => (e === 'heat' ? null : e));
  }, []);
  const backToWorld = useCallback(() => {
    setView('world');
    setCountry(null);
    setZoomed(false);
    setIntel(null); // a card belongs to the view that opened it
  }, []);

  /** Open the intel card for a town. `client` is a click position in VIEWPORT
   *  coordinates (a heat-map click), converted here into the map box's own
   *  frame — the panel owns the card's frame, so every view hands it a
   *  position and lets it do the clamping. `null` is the pinned corner slot
   *  the keyboard list uses. */
  const openIntel = useCallback((row: GeoCityRow, client: { x: number; y: number } | null) => {
    const box = mapRef.current;
    if (!client || !box || !anchoredCards()) {
      setIntel({ row, at: null });
      return;
    }
    const rect = box.getBoundingClientRect();
    setIntel({
      row,
      at: clampCardPosition(client.x - rect.left, client.y - rect.top, {
        width: box.clientWidth,
        height: box.clientHeight,
      }),
    });
  }, []);

  /** A click on the density map: a town, or nothing. Nothing CLOSES the card
   *  rather than leaving a stale one open over a place the reader just moved
   *  away from — a blob is soft, and "I missed" has to be legible. */
  const onHeatSelect = useCallback(
    (row: GeoCityRow | null, clientX: number, clientY: number) => {
      intelTriggerRef.current = null; // a heat blob is not focusable
      if (!row) {
        setIntel(null);
        return;
      }
      openIntel(row, { x: clientX, y: clientY });
    },
    [openIntel],
  );

  /**
   * "Show me that place" — a location clicked in the Visiting Organizations
   * panel below.
   *
   * Acted on in WHICHEVER view is open. The reader clicked while looking at
   * one map; silently switching them to the other would answer a question
   * they did not ask, and the two maps disagree about what a click even means
   * (the density map flies to a town, the choropleth drills into a country).
   *
   *   heat      — fly to the town and open its card, the same pair the Towns
   *               list uses. A country with no town we can place does nothing
   *               rather than moving the map somewhere arbitrary.
   *   world     — drill into the country, which is what clicking it does.
   *   country   — already inside a drill-down: open the town's card if it is
   *               this country's, otherwise switch to the requested one.
   *
   * Keyed on `focus?.nonce`, NOT on the object: the same location clicked
   * twice is the same value, and an effect keyed on it would fire once and
   * then go quiet for that place forever. The other reads are deliberately
   * out of the dep list for the same reason — this must fire on a click, not
   * on a town list arriving.
   */
  useEffect(() => {
    if (!focus) return;
    // ONE-SHOT, and the ref is what makes it one. A dep of `[focus?.nonce]`
    // cannot tell "the nonce changed" from "this component mounted with a
    // nonce already in the parent's state" — and the parent OUTLIVES this
    // panel, which is rendered inside `{tab === 'site' && …}`. So without
    // this a tab round-trip replayed a click made minutes ago: the page
    // smooth-scrolled itself down and the map re-drilled, on every
    // round-trip, forever. Initialising from the prop makes a mount that
    // inherits a stale focus a no-op; `focusSeq` pre-increments from 0 so a
    // real click always carries >= 1 and can never collide with the default.
    if (focus.nonce === handledFocusRef.current) return;
    handledFocusRef.current = focus.nonce;

    const box = mapRef.current;
    // The panel sits above the organizations list, so a click down there
    // moves the reader's answer off-screen unless we bring it back.
    box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Whatever the reader activated is where focus must RETURN when the card
    // closes. The two canvas paths null this deliberately (a heat blob is not
    // focusable); a location button is, and dropping it sent Escape's focus
    // to document.body and restarted tabbing at the top of the page.
    const trigger = document.activeElement;
    intelTriggerRef.current = trigger instanceof HTMLElement ? trigger : null;

    // WHAT to do is decided in locationFocus.ts, where the routing rules are
    // testable without a map; this only executes the answer.
    const plan = focusPlan({
      view,
      current: country,
      focus,
      towns: towns?.rows ?? [],
      cityRows,
      drillable,
    });
    if (plan.kind === 'flyToTown') {
      setFocusNonce((n) => n + 1);
      openIntel(plan.town, null);
    } else if (plan.kind === 'openTown') {
      openIntel(plan.town, null);
    } else if (plan.kind === 'enterCountry') {
      enterCountry(plan.country);
    }
    // Deps are the nonce ALONE, on purpose (see above). Everything else read
    // here is intentionally omitted: re-running when the town list loads or
    // the view changes would re-fly the map long after the click.
  }, [focus?.nonce]);

  /**
   * The zoom the label layer was last laid out for.
   *
   * The moved labels are offset in GEO units so the stack keeps its shape at
   * every viewport, which means they also scale with zoom — click New York and
   * Vermont's label used to swing four times further out into the Atlantic,
   * taking half the stack off the frame. `buildLabelLayer` divides the offsets
   * by the zoom, so this ref is what keeps the LIVE chart in step with a zoom
   * the React option never sees (click-zoom and roam are both imperative).
   */
  const labelZoomRef = useRef(1);
  const syncLabelZoom = useCallback(
    (zoom: number) => {
      const chart = chartRef.current;
      if (!chart || chart.isDisposed() || country !== US) return;
      const next = Math.max(1, zoom);
      // A wheel gesture fires a stream of georoam events; the labels only have
      // to keep up with the ones a reader can see. 2% is below the threshold
      // at which a 10px label visibly moves.
      if (Math.abs(next - labelZoomRef.current) / labelZoomRef.current < 0.02) return;
      labelZoomRef.current = next;
      // Merged by series ID, never by index: this option carries only the two
      // label series, and an index-keyed merge would rewrite the choropleth
      // and the city dots instead.
      //
      // `lazyUpdate` defers the update to zrender's next frame, so a wheel
      // gesture — which fires a stream of georoam events, several per frame —
      // collapses them into one instead of paying a full synchronous update
      // and canvas flush per event. The 2% gate above decides WHETHER the
      // labels moved enough to matter; this decides HOW OFTEN that decision
      // is allowed to reach the canvas, and the two are not the same lever.
      chart.setOption({ series: buildLabelLayer(US_STATE_LABELS, next) }, { lazyUpdate: true });
    },
    [country],
  );

  const captureChart = useCallback((chart: EChartsType) => {
    // Every view's instance lands here (one per key mount); the click-to-zoom
    // handler only ever runs while a country view is mounted.
    chartRef.current = chart;
  }, []);

  const resetView = useCallback(() => {
    setResetNonce((n) => n + 1);
    setZoomed(false);
    labelZoomRef.current = 1; // the remount lays out at the auto-fit again
  }, []);

  // The join, once per (asset, region payload). `owners` is what the
  // choropleth paints — one entry per POLYGON, carrying the subdivision row
  // above it — and `unmatched` is the honest remainder: regions the asset has
  // no shape for, which keep their rank-rail row and their numbers.
  const resolved = useMemo(() => {
    if (!shapes || shapes.code !== country) return null;
    return resolveRegions(shapes.index, regionRows);
  }, [shapes, country, regionRows]);

  const unmatchedNames = useMemo(
    () => new Set((resolved?.unmatched ?? []).map((row) => row.name)),
    [resolved],
  );

  const regionPaint: RegionPaint[] = useMemo(() => {
    if (!resolved) return [];
    return [...resolved.owners].map(([feature, row]) => ({
      feature,
      label: row.name,
      views: row.views,
      visitors: row.visitors,
    }));
  }, [resolved]);

  // World: clicking a country with region data drills in. Country: clicking a
  // dot opens its intel card, and clicking any region zooms to it — which is
  // also what un-piles crowded city dots, since symbols keep their pixel size
  // while the geography under them expands.
  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const p = params as {
          name?: string;
          seriesType?: string;
          data?: { row?: GeoCityRow };
          event?: { offsetX?: number; offsetY?: number };
        } | null;
        if (!p?.name) return;
        if (view === 'world') {
          // Through enterCountry, same as the rank rail's buttons — a raw
          // setView here used to leak a world roam's Reset pill into the
          // fresh drill-down's auto-fit.
          if (drillable.has(p.name)) enterCountry(p.name);
          return;
        }
        if (p.seriesType === 'scatter') {
          // A dot is a place, not a frame: it opens the card, never zooms.
          const row = p.data?.row;
          if (!row) return;
          const box = mapRef.current;
          intelTriggerRef.current = null; // a canvas dot is not focusable
          // ECharts reports offsets inside the canvas, which shares an origin
          // with the map box, so this path clamps directly rather than going
          // through openIntel's viewport conversion. On a phone it takes the
          // same docked slot everything else does.
          setIntel({
            row,
            at: anchoredCards()
              ? clampCardPosition(p.event?.offsetX ?? 0, p.event?.offsetY ?? 0, {
                  width: box?.clientWidth ?? 0,
                  height: box?.clientHeight ?? 0,
                })
              : null,
          });
          return;
        }
        const info = shapes;
        const chart = chartRef.current;
        if (!info || !chart || chart.isDisposed()) return;
        // A subdivision the join spread over several polygons (England is 150
        // districts) is framed by their UNION — zooming to whichever one was
        // under the cursor would frame a county and call it a country.
        const owner = resolved?.owners.get(p.name);
        const frameNames = (owner && resolved?.featuresByRegion.get(owner.name)) ?? [p.name];
        const bounds = unionBounds(
          frameNames.map((name) => info.bounds.byName[name]).filter(Boolean),
        );
        if (!bounds) return;
        // No plot rect: with the fit aspect-preserving, the zoom that frames a
        // region is a ratio between two boxes in PROJECTED space and the pixels
        // cancel out — see viewForBounds. Measuring against the plot rect (as
        // this did) would now over-zoom by the letterbox overhang.
        // The label suppression rides along with every merge: a bare
        // {center, zoom} merge re-armed the geo's own hover emphasis with
        // ECharts' default region-name stamp (measured 2026-08-30) even
        // though the built option already said show:false.
        const fit = viewForBounds(bounds, info.bounds.frame);
        chart.setOption({
          geo: {
            ...fit,
            emphasis: { label: { show: false } },
          },
        });
        // The stack rides the same zoom the geography just took.
        syncLabelZoom(fit.zoom);
        setZoomed(true);
      },
      // Wheel zoom / drag pan, ANY view. The event also fires when
      // scaleLimit clamps the gesture to NOTHING (a wheel-down at the zoom
      // floor), and even a clamped roam writes a concrete `center` into the
      // option (measured 2026-08-30) — so the tells are the RESULTING zoom
      // and the event's own pan deltas, never `center != null`. A drag pan
      // carries dx/dy and really moves the view; a clamped wheel carries
      // neither and leaves zoom at the floor.
      georoam: (params: unknown) => {
        const chart = chartRef.current;
        if (!chart || chart.isDisposed()) return;
        const p = params as { dx?: number; dy?: number } | null;
        const opt = chart.getOption() as {
          geo?: Array<{ zoom?: number }>;
          series?: Array<{ zoom?: number }>;
        };
        const zoom = (view === 'country' ? opt.geo?.[0] : opt.series?.[0])?.zoom ?? 1;
        syncLabelZoom(zoom);
        setZoomed(zoom > 1.0001 || p?.dx != null || p?.dy != null);
      },
    }),
    [view, drillable, enterCountry, shapes, resolved, syncLabelZoom],
  );

  const worldOption = useMemo(
    () => buildWorldOption({ countries, bins: worldBins }),
    [countries, worldBins],
  );

  const cityPoints: CityPoint[] = useMemo(() => {
    const peak = Math.max(1, ...cityRows.map((c) => c.views));
    const points: CityPoint[] = [];
    for (const c of cityRows) {
      // The US asset is PLANAR, so its dots are pre-projected into the same
      // frame as the outlines. Every other country's geo component carries a
      // real projection and takes degrees, projecting the dots itself.
      const xy = isUsView ? albersUsaProject([c.lng, c.lat]) : ([c.lng, c.lat] as [number, number]);
      // A centroid the geo database put outside the three albers zones has
      // nowhere honest to sit — drop it rather than clamp it onto a state it
      // does not belong to.
      if (!xy) continue;
      const radius = CITY_R_MIN + (CITY_R_MAX - CITY_R_MIN) * Math.sqrt(c.views / peak);
      points.push({
        name: cityLabel(c),
        value: [xy[0], xy[1], c.views],
        symbolSize: radius * 2,
        // Each dot takes ITS OWN bin's color off the same ladder the regions
        // use, so the one piecewise legend under the map explains both layers.
        itemStyle: { color: binColorFor(c.views, regionBins) },
        row: c,
      });
    }
    return points;
  }, [cityRows, regionBins, isUsView]);

  const countryOption = useMemo(() => {
    if (!shapes || shapes.code !== country) return null;
    return buildCountryOption({
      mapName: shapes.mapName,
      projection: shapes.projection,
      regions: regionPaint,
      cityPoints,
      bins: regionBins,
      // The United States is the one country whose subdivisions have measured
      // label anchors (stateLabels.ts). Everywhere else the geometry is a
      // Natural Earth admin-1 set nobody has placed labels in, and guessing
      // them would put text on top of the data — so those views carry none.
      labels: shapes.code === US ? US_STATE_LABELS : undefined,
    });
  }, [shapes, country, regionPaint, cityPoints, regionBins]);

  /**
   * The gold beacon (2026-09-01). While a town's intel card is open on a
   * country view, its dot ripples so the reader can see WHICH dot the card
   * describes — the answer to a "Where & how" click that lands on a map of
   * forty near-identical dots. Applied imperatively BY SERIES ID because the
   * option prop is notMerge: `countryOption` is a dep precisely so a rebuild
   * (segment change, refresh) that wipes the merged series puts it back —
   * child effects run before this one, so the notMerge apply always loses.
   * The US frame is planar, so the beacon pre-projects exactly as the dots
   * do; a centroid outside the albers zones clears it rather than guessing.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed() || view !== 'country') return;
    const row = intel?.row ?? null;
    const point = row
      ? isUsView
        ? albersUsaProject([row.lng, row.lat])
        : ([row.lng, row.lat] as [number, number])
      : null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    chart.setOption({ series: [focusBeacon(point, reduced)] }, { lazyUpdate: true });
  }, [intel, view, isUsView, countryOption]);

  // The option prop is applied notMerge, so ANY rebuild (segment change,
  // data refresh) silently resets a wheel roam — the pill must not outlive
  // the zoom it described. Imperative click-zooms rebuild nothing, so the
  // pill correctly survives them.
  useEffect(() => {
    setZoomed(false);
    // The option prop is applied notMerge, so a rebuild also puts the geo back
    // at its auto-fit — and with it the label layer this ref tracks.
    labelZoomRef.current = 1;
  }, [worldOption, countryOption]);

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

  const isCountry = view === 'country';
  const isHeat = view === 'heat';
  // The towns this view can open a card for: a country's, or the world's.
  // ONE list feeding ONE keyboard route feeding ONE card — the density view
  // stopped being the view you could only look at when this stopped being
  // `isCountry ? cityRows : []`.
  const townRows: GeoCityRow[] = isHeat ? heatRows : isCountry ? cityRows : [];
  const regionNoun = isUsView ? 'state' : 'region';
  const chartReady = isCountry ? countryOption !== null && dataReady : mapReady;
  const showingCollecting = isHeat
    ? locatedTowns === 0
    : isCountry
      ? dataReady && regionRows.length === 0
      : countries.length === 0;
  // The density layer plots LOCATED VISITS, which is exactly what the world
  // view's copy already explains — so heat borrows that wording rather than
  // inventing a third one.
  const collect = collectingCopy(
    isCountry ? regionNoun : null,
    segment,
    isCountry ? (detail?.regionTrackedSince ?? regionTrackedSince) : geoTrackedSince,
  );
  // A country with visitor data but no committed outline is a REAL state, not
  // a failure: Natural Earth's admin-1 set does not reach every territory. It
  // reads differently from a broken chunk because the fix is different — there
  // is nothing to retry, and the numbers on the right are the whole answer.
  const noShapes = isCountry && country !== null && country !== US && !ADMIN1_COUNTRIES.has(country);
  const loadingCopy = noShapes
    ? `No map outline for ${countryName(country ?? '')} \u2014 its regions are listed on the right.`
    : mapError === view
      ? 'The map could not load \u2014 refresh to try again.'
      : 'Loading map…';

  // The map box's body, resolved once here rather than as three nested
  // ternaries inside the JSX.
  let mapBody: ReactNode;
  if (isHeat) {
    mapBody = showingCollecting ? (
      <div className={styles.wmHeatGhost} />
    ) : HeatView ? (
      <HeatView
        towns={heatRows}
        fitNonce={resetNonce}
        onRoam={setZoomed}
        onSelect={onHeatSelect}
        selected={intel?.row ?? null}
        focusNonce={focusNonce}
      />
    ) : (
      <div className={styles.wmLoading}>{loadingCopy}</div>
    );
  } else if (chartReady) {
    mapBody = (
      <EChart
        key={`${view}:${country ?? ''}:${resetNonce}`}
        option={isCountry ? countryOption! : worldOption}
        onEvents={onEvents}
        onReady={captureChart}
        // The stage owns the height (CSS aspect-ratio, clamped) — the chart
        // just fills it, and the wrapper's ResizeObserver keeps it fitted.
        style={{ height: '100%' }}
      />
    );
  } else {
    mapBody = <div className={styles.wmLoading}>{loadingCopy}</div>;
  }

  const title = isCountry
    ? `${flagEmoji(country ?? '')} ${countryName(country ?? '')}`.trim()
    : isHeat
      ? 'Visitor Density'
      : 'Visitors by Country';

  // The sea plate's own proportions, published to the SCSS as `--wm-aspect`
  // (2026-08-31). The frame TRACKS ITS SUBJECT rather than approximating one
  // shape for all three views, because the subjects are not one shape: the
  // world is 2.30:1, the United States 1.71:1, and the admin-1 assets run
  // from Chile at 0.19 to Puerto Rico at 4.26 (measured over all 236). A
  // single CSS ratio can serve at most one of them, which is what the old
  // hardcoded 15/8 was — an approximation of the world that then had to be
  // dropped entirely below tablet.
  //
  // This is COMPOSITION now, not correctness: `preserveAspect` means a frame
  // that disagrees with its map costs a band of open water and nothing else.
  // The plate is drawn as sea (graticule + vignette), so that band reads as
  // ocean — but there is no reason to spend a phone's vertical budget on
  // ocean when the number that would avoid it is already in hand. The height
  // clamps in the SCSS are what keep a portrait country from a two-screen
  // card and a wide one from a letterbox slot.
  //
  // The density view keeps the world's frame: it IS the world, and a Leaflet
  // map fills whatever box it is given.
  const stageStyle = useMemo(() => {
    const aspect =
      isCountry && shapes && shapes.code === country
        ? frameAspect(shapes.bounds.frame)
        : WORLD_FRAME_ASPECT;
    return { '--wm-aspect': String(aspect) } as CSSProperties;
  }, [isCountry, shapes, country]);

  return (
    <div className={`${styles.chartCard} ${styles.chartFull} ${styles.wmCard}`}>
      <div className={styles.chartHead}>
        <div className={styles.wmTitleRow}>
          {(isCountry || isHeat) && (
            <button type="button" className={styles.wmCrumb} onClick={backToWorld}>
              <span aria-hidden="true">&#8592;</span> World
            </button>
          )}
          <h3 className={`${styles.chartTitle} ${styles.wmTitle}`}>{title}</h3>
          {zoomed && (
            <button type="button" className={styles.wmCrumb} onClick={resetView}>
              Reset view
            </button>
          )}
          {/* Offered from the world view only. The density layer IS the world
              — reaching it from a drill-down would be a third pill in a row
              that already carries a crumb, a title and a Reset, to save one
              click on the "World" pill sitting beside it. Gated on having
              points for the same reason a country is gated on having regions:
              a view that can only say "collecting" is not worth an
              entrance. */}
          {!isCountry && !isHeat && locatedTowns > 0 && (
            <button type="button" className={styles.wmCrumb} onClick={enterHeat}>
              Heat map <span aria-hidden="true">&#8594;</span>
            </button>
          )}
        </div>
        <span className={`${styles.chartSub} ${styles.wmSub}`}>
          {showingCollecting
            ? `Collecting — ${isCountry ? regionNoun : 'country'} is recorded from today forward`
            : isHeat
              ? `${segmentLabel(segment)} density — click a town for detail`
              : isCountry
                ? `${segmentLabel(segment)} by ${regionNoun} — click to zoom, a town for detail`
                : `${segmentLabel(segment)} by location — click a country to drill in`}
        </span>
      </div>

      <div className={styles.wmBody} data-collecting={showingCollecting || undefined}>
        <div className={styles.wmMap} ref={mapRef}>
          {/* The stage owns the map's proportions — `--wm-aspect` above, then
              aspect-ratio + height clamps in the SCSS — so a loading div, a
              canvas and a tile map all occupy the same frame. */}
          <div className={styles.wmStage} style={stageStyle}>
            {mapBody}
          </div>
          {/* The one scale for both CHOROPLETH layers, as DOM below the
              canvas — never painted over the geography, whatever the zoom
              does. The density view is excluded on purpose: its color comes
              from accumulated alpha rather than from these bins, so the
              legend would be describing something that view does not do —
              it carries its own gradient key below instead. */}
          {!isHeat && !showingCollecting && chartReady && (
            <div className={styles.wmLegend}>
              {(isCountry ? regionBins : worldBins).map((b) => (
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
          {/* The density view's key: the blue->red gradient with the window's
              own decades ticked along it, positioned by the same ladder that
              scaled the weights. It reads what a LONE town of that count
              paints; overlap only ever pushes a cell hotter, which the title
              text says. */}
          {isHeat && !showingCollecting && heatTicks.length > 0 && (
            <div className={styles.wmHeatKey}>
              <span className={styles.wmHeatKeyLabel}>Views per town</span>
              <span
                className={styles.wmHeatKeyScale}
                title="Overlapping towns accumulate toward the hot end"
              >
                <span className={styles.wmHeatKeyBar} aria-hidden="true" />
                {heatTicks.map((t) => (
                  <span key={t.label} className={styles.wmHeatKeyTick} style={{ left: `${t.t * 100}%` }}>
                    {t.label}
                  </span>
                ))}
              </span>
            </div>
          )}
          {/* Any view that has places in it can have a card open — the two
              choropleth drill-downs and the density map all open THIS one. */}
          {intel && (
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

        {/* The rail stays up in the density view, listing countries: it is the
            same data the layer is drawing, it is the card's only exact-number
            readout, and it is the only part of the box a keyboard can reach
            once the map is a canvas. */}
        {!showingCollecting && (
          <div className={styles.wmRank}>
            {isCountry
              ? regionRows
                  .slice(0, RANK_ROWS)
                  .map((r) => (
                    <RankRow
                      key={r.name}
                      name={r.name}
                      views={r.views}
                      max={regionMaxViews}
                      note={
                        unmatchedNames.has(r.name)
                          ? 'No map outline for this region — the visits are still counted'
                          : undefined
                      }
                    />
                  ))
              : countries.slice(0, RANK_ROWS).map((c) => (
                  <RankRow
                    key={c.code}
                    flag={flagEmoji(c.code)}
                    name={countryName(c.code)}
                    views={c.views}
                    max={maxViews}
                    // Buttons, not rows, for a country the reader may open:
                    // the canvas click is the discoverable way in but it is
                    // not a keyboard one, and a single "United States" pill
                    // stopped being the answer once every country drills in.
                    onOpen={drillable.has(c.code) ? () => enterCountry(c.code) : undefined}
                  />
                ))}
            {townRows.length > 0 && (
              <div className={styles.wmTowns}>
                <span className={styles.wmTownsTitle}>Towns · {townRows.length}</span>
                {/* Buttons, not rows: the things they mirror are canvas pixels
                    and heat blobs, so this list is the only keyboard route to
                    a town's card — which is why it lists EVERY town,
                    scrolling, not a top 6 that would leave the rest
                    pointer-only. The density view gets the same list for
                    exactly that reason: a view you can only look at is not a
                    reporting view. */}
                <div className={styles.wmTownsList}>
                  {townRows.map((c) => (
                    <button
                      key={townKey(c)}
                      type="button"
                      className={
                        isHeat ? `${styles.wmTown} ${styles.wmTownGlobal}` : styles.wmTown
                      }
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        intelTriggerRef.current = e.currentTarget;
                        // The density map flies to a town chosen here; the
                        // choropleth ignores the nonce and simply opens.
                        setFocusNonce((n) => n + 1);
                        openIntel(c, null);
                      }}
                    >
                      {/* The global list spans countries, so it carries the
                          flag the world rail carries. `cityLabel` stays the
                          same string everywhere — the flag is beside it, not
                          inside it. */}
                      {isHeat && c.country && (
                        <span className={styles.wmTownFlag} aria-hidden="true">
                          {flagEmoji(c.country)}
                        </span>
                      )}
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
 *  world rail carries one, the region rail takes the column back. `onOpen`
 *  makes the row a button — the keyboard path into a country. `note` marks a
 *  region the country's asset has no outline for: the row still reports its
 *  real numbers, it simply cannot be painted. */
function RankRow({
  flag,
  name,
  views,
  max,
  onOpen,
  note,
}: {
  flag?: string;
  name: string;
  views: number;
  max: number;
  onOpen?: () => void;
  note?: string;
}) {
  const className = flag === undefined ? `${styles.wmRow} ${styles.wmRowPlain}` : styles.wmRow;
  const body = (
    <>
      {flag !== undefined && (
        <span className={styles.wmFlag} aria-hidden="true">
          {flag}
        </span>
      )}
      <span className={styles.wmName} title={note ?? name}>
        {name}
      </span>
      <span className={styles.wmTrack}>
        <span className={styles.wmFill} style={{ width: `${Math.max(4, (views / max) * 100)}%` }} />
      </span>
      <span className={styles.wmVal}>{views.toLocaleString()}</span>
    </>
  );
  if (!onOpen) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      className={`${className} ${styles.wmRowOpen}`}
      onClick={onOpen}
      title={`Drill into ${name}`}
    >
      {body}
    </button>
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

      {(row.addresses ?? []).length > 0 && (
        <div className={styles.wmIntelSection}>
          <span className={styles.wmIntelLabel}>Addresses</span>
          {(row.addresses ?? []).map((a) => (
            <span
              key={a.ip}
              className={`${styles.wmIntelLine} ${styles.wmIntelMono}`}
              title={`${a.ip} — ${a.views} views`}
            >
              {a.ip} ({a.views})
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
