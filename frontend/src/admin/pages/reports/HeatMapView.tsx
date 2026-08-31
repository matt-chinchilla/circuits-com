// Visitor Density — the geography panel's third view (2026-08-30).
//
// A REAL slippy map: raster tiles with roads and labels, zoom and pan, under
// a blurred blue->cyan->green->yellow->red density layer. That is the look of
// luka1199/geo-heatmap, which the owner asked for; that project is Folium,
// which is Leaflet + Leaflet.heat over OSM tiles, so this reproduces it with
// Leaflet directly rather than through Folium's generated HTML.
//
// ── Why OSM's own tiles, and why they are darkened in CSS ──────────────────
// The plan was CARTO's keyless dark basemap. MEASURED 2026-08-30: CARTO no
// longer has a keyless tier — every style (dark_all, voyager) still returns
// HTTP 200 with a tile, but the tile is stamped "API KEY REQUIRED", so the
// failure is a watermark rather than an error and no status check would have
// caught it. Do not "restore" a cartocdn URL without loading one and LOOKING
// at it.
//
// So the basemap is OpenStreetMap's own standard tiles: keyless, genuinely
// free under a published usage policy, and the exact basemap the reference
// project uses. They are LIGHT, which a night-indigo panel is not, so the
// SCSS darkens the tile pane with a compositor-friendly filter — measured at
// 16.6ms median / zero frames over 32ms through four zoom animations, which
// is the same as no filter at all (this repo's standing suspicion of `filter`
// is about blur and drop-shadow, not about an inverted raster).
//
// OSM's tile policy is the constraint that matters if this ever moves: it
// permits light use like an admin panel, not a public page's traffic.
//
// ── This layer speaks a DIFFERENT visual language from the rest of the card ─
// The choropleth and the city dots share ONE inferno ramp, explained by the
// DOM legend under the map (viewershipBins.ts). This layer deliberately does
// not join them. Its color is the reference's blue->red family, and more to
// the point a heat blob's color comes from ACCUMULATED alpha at each pixel
// rather than from a per-feature bin — so a piecewise legend would be
// describing something the layer does not do. That is why the panel hides the
// bin legend while this view is up, and why retinting VIEWERSHIP_RAMP must
// not drag this gradient along with it.
//
// ── Bundle discipline ──────────────────────────────────────────────────────
// Leaflet plus its CSS is ~163 kB that only this view needs, so WorldMapPanel
// reaches this file through a dynamic `import()` and it lands in its own
// async chunk. Nothing the public entry statically reaches may import it —
// the same rule the EChart wrapper carries.
//
// ── This view REPORTS, it is not only a picture (2026-08-30) ───────────────
// It used to paint anonymous [lat, lng, views] triples, so a click could not
// say which town it had hit and every piece of reporting depth lived in the
// choropleth views instead. Owner call: "having those functionalities be
// fully-separated in the 2 maps feels strange". So the layer is built from
// IDENTIFIED town rows (GET /dashboard/towns — the drill-down's own bubble
// aggregation with the country dropped), and a click opens the SAME
// CityIntelCard the choropleth dots open, from the same `cityIntel.ts`
// helpers. There is no second card and no second notion of what a place is.
//
// A heat blob is soft, so hit-testing is NEAREST-TOWN-WITHIN-A-SCREEN-RADIUS
// rather than a polygon test: `HIT_RADIUS_PX` in SCREEN pixels, so the target
// stays the same size at every zoom. A click that lands in empty ocean
// resolves to nothing and closes the card rather than opening an empty one.
//
// ── Touch: two fingers to pan, one finger to scroll the page ───────────────
// A full-width map that swallows vertical swipes is a real trap on a phone.
// Leaflet's dragging is therefore DISABLED on a coarse pointer and enabled
// only while two fingers are down (the capture-phase listener runs before
// Leaflet's own touchstart handler, so the very gesture that enables dragging
// is the one Leaflet then drags with). Pinch-zoom is unaffected — it is
// two-fingered already — and a one-finger drag scrolls the page and raises a
// short hint saying so. On a fine pointer nothing changes.
//
// ── Leak discipline ────────────────────────────────────────────────────────
// A Leaflet map owns tile requests, document-level handlers and an animation
// frame, so `map.remove()` on unmount is MANDATORY. This repo has a
// documented history of orphaned render loops (csFx, 2026-06-22); a detached
// map still fetching tiles is the same class of bug.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { prefersReducedMotion } from '@admin/components/charts/chartTheme';
import type { GeoCityRow } from '@admin/types/admin';
import { heatBounds, heatBrushForZoom, normalizeHeatDecades } from './heatWeights';
import type { HeatPoint } from './heatWeights';
import styles from './ReportsPage.module.scss';

/** Keyless and free — the reason no Google Maps billing account is in the
 *  picture. Single host: the old a/b/c subdomain sharding is deprecated. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** A LICENSE REQUIREMENT, not decoration: OpenStreetMap's terms require the
 *  credit to be visible on the map itself. Leaflet paints it into the corner
 *  control; the SCSS restyles that control to suit a dark panel and never
 *  suppresses it. */
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Leaflet's own credit, minus the flag graphic its 1.9 default carries —
 *  the credit is worth keeping, the graphic is noise in an admin panel. */
const LEAFLET_PREFIX = '<a href="https://leafletjs.com/">Leaflet</a>';

/** OSM's standard tiles stop at 19; asking for 20 only earns 404s. */
const TILE_MAX_ZOOM = 19;
/** Where the map sits when there is nothing to fit to. */
const WORLD_CENTER: [number, number] = [20, 0];
const WORLD_ZOOM = 2;
/** How far the initial fit may zoom in. Without it a window whose traffic all
 *  came from one metro opens at street level, which is a picture of one road
 *  rather than of the visitors. */
const FIT_MAX_ZOOM = 6;

/**
 * The reference's ramp, not this card's inferno one — see the header. The
 * stops are read off ACCUMULATED alpha, so the low end is what a lone
 * tail point paints and the high end is what a hotspot (or a genuinely dense
 * cluster) burns through to.
 *
 * Five stops for a reason: weights arrive laddered by ORDER OF MAGNITUDE
 * (heatWeights.ts), so with a three-decade window each decade lands roughly
 * one stop further along — the ones blue, the tens cyan, the hundreds green,
 * the thousands yellow into red.
 */
const HEAT_GRADIENT: Record<number, string> = {
  0.2: '#2c5cff', // deep blue — one town, one view
  0.4: '#12d7e6', // cyan
  0.6: '#3ddc7f', // green
  0.8: '#ffd23f', // yellow
  1.0: '#ff3b1f', // red — the peak of the window
};

const HEAT_OPTIONS: L.HeatMapOptions = {
  // Weights arrive pre-scaled onto [DECADE_FLOOR, 1] by heatWeights.ts, so the
  // divisor is 1 and a cell's accumulated weight IS its alpha. Anything above
  // 1 is a cell holding several points, which clips to full heat on purpose:
  // that clipping is what makes density read as density.
  max: 1,
  // THE trap in this plugin. leaflet.heat multiplies every weight by
  // 1 / 2^min(maxZoom - zoom, 12), defaulting maxZoom to the MAP's max zoom —
  // which here is 19, so at a world view of zoom 2 every weight would be
  // scaled by 1/4096 and the layer would simply not appear. Our weights are
  // already normalised for the whole window rather than per-zoom, so we opt
  // out of that factor entirely: pinning maxZoom to 0 makes the exponent
  // clamp to 0, and the factor exactly 1, at every zoom we can reach.
  maxZoom: 0,
  // radius/blur are deliberately ABSENT here: they are screen-pixel values,
  // so one fixed pair cannot serve both a world view and a street view — at
  // z2 the old 24/18 smeared one metro across a subcontinent. The zoom-scaled
  // pair comes from heatBrushForZoom (heatWeights.ts, where the ladder is
  // testable), merged in at layer construction and re-applied on `zoomend`.
  // Left at the plugin's default so it sits BELOW heatWeights' DECADE_FLOOR
  // (0.18) and can never quietly override the ladder — that module is the one
  // authority on how faint the bottom decade is allowed to get.
  minOpacity: 0.05,
  gradient: HEAT_GRADIENT,
};

/**
 * leaflet.heat, loaded once per session.
 *
 * The plugin's dist is a classic Leaflet plugin script — no module wrapper at
 * all. It reads `L.Layer` and writes `L.HeatLayer` / `L.heatLayer` on whatever
 * `L` its scope resolves to, which under a bundler is the GLOBAL one, so the
 * global has to exist before the plugin module evaluates. Two consequences
 * shape this function:
 *
 *  - the import must be DYNAMIC, because a static `import 'leaflet.heat'`
 *    would hoist above the assignment below and blow up on `L is not defined`;
 *  - the global cannot be the ES module namespace object, which is SEALED —
 *    the plugin's very first act is to add a property to it. It gets a mutable
 *    shallow copy instead, which carries the same `Layer`, `Bounds`, `point`
 *    and `DomUtil` the plugin reaches for, so the layers it constructs are
 *    genuine Leaflet layers.
 *
 * The global stays set for the life of the page: the plugin's `_animateZoom`
 * reaches for `L.DomUtil` on every zoom, not just at construction.
 */
let heatPluginPromise: Promise<typeof L.heatLayer> | null = null;

function loadHeatPlugin(): Promise<typeof L.heatLayer> {
  heatPluginPromise ??= (async () => {
    const scope: Record<string, unknown> = { ...L };
    (window as unknown as { L?: unknown }).L = scope;
    await import('leaflet.heat');
    return scope.heatLayer as typeof L.heatLayer;
  })();
  return heatPluginPromise;
}

/** How near a click must land to count as hitting a town, in SCREEN pixels
 *  at any zoom. 28 is a finger — a hair over the 24px Leaflet uses for its
 *  own marker tolerance and inside the 44px tap target the rest of this
 *  console aims for, which is right for a target the user can see. */
const HIT_RADIUS_PX = 28;

/** How long the "two fingers" hint stays up after a one-finger drag. */
const TOUCH_HINT_MS = 1600;

export interface HeatMapViewProps {
  /** Identified towns — the layer's paint AND its click target. Grouped by
   *  (country, city, region) with an averaged centroid, exactly like the
   *  choropleth's bubbles, so the two maps agree about what a place is. */
  towns: GeoCityRow[];
  /** Bumped by the panel's "Reset view" pill. Any change re-frames the map on
   *  the data; the map is NOT remounted, because rebuilding it would throw
   *  away a warm tile cache to do what one `fitBounds` does. */
  fitNonce?: number;
  /** True once the user has moved the map off that framing, false when a
   *  re-fit puts it back — this is what the Reset pill is bound to. */
  onRoam?: (roamed: boolean) => void;
  /** A click resolved to a town. The client coordinates travel with it so the
   *  panel can anchor the card in ITS box — the panel owns the card's frame,
   *  not this map. `null` is a click that hit nothing. */
  onSelect?: (town: GeoCityRow | null, clientX: number, clientY: number) => void;
  /** The town whose card is open, ringed on the map so a soft blob's click
   *  visibly resolved to a place. */
  selected?: GeoCityRow | null;
  /** Bumped when `selected` was chosen from the KEYBOARD list rather than by
   *  clicking the map, which is when the map should fly to it. A map click
   *  must not re-centre under the user's own cursor. */
  focusNonce?: number;
}

export default function HeatMapView({
  towns,
  fitNonce = 0,
  onRoam,
  onSelect,
  selected = null,
  focusNonce = 0,
}: HeatMapViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatRef = useRef<L.HeatLayer | null>(null);
  // Set around every move WE make. Leaflet fires `moveend` identically for a
  // programmatic fit, a container resize and a user drag, and only the last
  // of those should raise the Reset pill. Both of our moves fire the event
  // synchronously inside the call, so a plain flag is enough — no timers.
  const selfMoveRef = useRef(false);
  // The ring drawn under the open card, and the "two fingers" hint.
  const markerRef = useRef<L.CircleMarker | null>(null);
  const [touchHint, setTouchHint] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest-refs: the listener effects below must not re-bind on every parent
  // render just because a callback identity or the town list changed. The map
  // is built ONCE; its handlers read the current values through these.
  const onRoamRef = useRef(onRoam);
  onRoamRef.current = onRoam;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const townsRef = useRef(towns);
  townsRef.current = towns;

  // The density layer's own input, derived from the identified rows. Bare
  // triples are still what leaflet.heat wants — identity lives beside them in
  // `towns`, keyed by position in the same array.
  const points: HeatPoint[] = useMemo(
    () => towns.map((t) => [t.lat, t.lng, t.views] as HeatPoint),
    [towns],
  );
  const heatPoints = useMemo(() => normalizeHeatDecades(points), [points]);
  const bounds = useMemo(() => heatBounds(heatPoints), [heatPoints]);

  // (1) Lifecycle. Runs once (twice under StrictMode, which tears the map
  // down and rebuilds it — `map.remove()` clears the container's leaflet id,
  // so the second init does not hit "Map container is already initialized").
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Read per mount, same as the EChart wrapper: a reduced-motion user gets
    // instant zoom/fade cuts instead of Leaflet's ~250ms scale animation.
    const animate = !prefersReducedMotion();
    const map = L.map(host, {
      center: WORLD_CENTER,
      zoom: WORLD_ZOOM,
      minZoom: 1,
      maxZoom: TILE_MAX_ZOOM,
      scrollWheelZoom: true,
      worldCopyJump: true,
      // TOP-RIGHT, not Leaflet's top-left default: the panel's pinned intel
      // card opens at the top-left of the map box (that is the slot the
      // keyboard towns list uses), and the two landed on exactly the same
      // pixels — measured 2026-08-31 at 390px, both at x=37 y=82, with
      // leaflet's control painting over the card's title. Top-right is also
      // clear of the attribution, which lives bottom-right and is a license
      // requirement that has to stay legible.
      zoomControl: false,
      attributionControl: true,
      zoomAnimation: animate,
      fadeAnimation: animate,
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix(LEAFLET_PREFIX);
    L.tileLayer(TILE_URL, {
      maxZoom: TILE_MAX_ZOOM,
      attribution: TILE_ATTRIBUTION,
    }).addTo(map);

    // Two-finger pan on a touch device — see the header. Gated on POINTER
    // TYPE, not on viewport width: a touch laptop keeps its mouse dragging,
    // and a narrow desktop window is not a phone.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    let releaseTouch: (() => void) | undefined;
    if (coarse) {
      map.dragging.disable();
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length >= 2) map.dragging.enable();
      };
      const onTouchMove = (e: TouchEvent) => {
        // One finger: the page is scrolling, not the map. Say so once rather
        // than leaving the reader to conclude the map is broken.
        if (e.touches.length >= 2) return;
        setTouchHint(true);
        if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
        hintTimerRef.current = setTimeout(() => setTouchHint(false), TOUCH_HINT_MS);
      };
      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length < 2) map.dragging.disable();
      };
      // CAPTURE phase: Leaflet listens on this same container, so enabling
      // dragging here happens before its handler sees the very touchstart
      // that enabled it — otherwise the first two-finger gesture would be
      // swallowed and the user would have to try twice.
      host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      host.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
      host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      host.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
      releaseTouch = () => {
        host.removeEventListener('touchstart', onTouchStart, { capture: true });
        host.removeEventListener('touchmove', onTouchMove, { capture: true });
        host.removeEventListener('touchend', onTouchEnd, { capture: true });
        host.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      };
    }

    // Hit-testing: nearest town within HIT_RADIUS_PX of the click, measured
    // in SCREEN space so the target is the same size at every zoom. Empty
    // ocean resolves to null, which closes the card rather than opening an
    // empty one.
    map.on('click', (e: L.LeafletMouseEvent) => {
      const select = onSelectRef.current;
      if (!select) return;
      const origin = e.containerPoint;
      let best: GeoCityRow | null = null;
      let bestDistance = HIT_RADIUS_PX;
      for (const town of townsRef.current) {
        const point = map.latLngToContainerPoint([town.lat, town.lng]);
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = town;
        }
      }
      const src = e.originalEvent;
      select(best, src.clientX, src.clientY);
    });
    // The brush is screen pixels, so its geographic meaning changes with the
    // zoom — every zoomend re-tunes it off the ladder, tighter zoomed out.
    // (setOptions redraws through the plugin's own rAF-scheduled _redraw.)
    map.on('zoomend', () => {
      heatRef.current?.setOptions(heatBrushForZoom(map.getZoom()));
    });
    mapRef.current = map;

    // Leaflet renders a grey half-map when its container changes size after
    // init, which is exactly what a grid cell in this panel does on the first
    // layout pass and on every window resize.
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) return;
      selfMoveRef.current = true;
      map.invalidateSize({ animate: false });
      selfMoveRef.current = false;
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      releaseTouch?.();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);

      // DETACH THE HEAT LAYER BEFORE THE MAP GOES, AND CANCEL ITS FRAME.
      // leaflet.heat redraws on a requestAnimationFrame it stores as `_frame`
      // and its `_redraw` reads `this._map.getSize()` with no null guard, so a
      // frame queued by the last zoom/resize and delivered AFTER `map.remove()`
      // throws `Cannot read properties of null (reading 'getSize')`. Toggling
      // world -> heat -> world quickly is enough to hit it (found 2026-08-31).
      // Removing the layer alone does not help: the frame is already queued and
      // fires against a detached layer. `_frame` is library-internal, hence the
      // narrow cast and the optional handling — if a future version renames it
      // the worst case is the old behaviour, not a new crash.
      const heat = heatRef.current as (L.HeatLayer & { _frame?: number }) | null;
      heatRef.current = null;
      if (heat) {
        if (heat._frame) {
          L.Util.cancelAnimFrame(heat._frame);
          heat._frame = 0;
        }
        map.removeLayer(heat);
      }

      markerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // (2) Roam reporting. Declared BEFORE the fit effect so the initial fit is
  // already being listened to and correctly reports "not roamed".
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMoveEnd = () => {
      if (selfMoveRef.current) return;
      onRoamRef.current?.(true);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, []);

  // (3) The heat layer. Rebuilt whenever the scaled points change — a segment
  // switch or a window change re-scales every weight against a new peak, so
  // there is nothing to merge into the old layer.
  useEffect(() => {
    let cancelled = false;
    loadHeatPlugin()
      .then((heatLayer) => {
        const map = mapRef.current;
        if (cancelled || !map) return;
        if (heatRef.current) map.removeLayer(heatRef.current);
        heatRef.current = heatLayer(heatPoints, {
          ...HEAT_OPTIONS,
          ...heatBrushForZoom(map.getZoom()),
        }).addTo(map);
      })
      // A failed chunk leaves the basemap and its attribution standing rather
      // than blanking the panel; the rank rail beside it still has the
      // numbers.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [heatPoints]);

  // (4) Framing. Runs on mount, whenever the data's extent changes, and on
  // every Reset. `animate: false` keeps `moveend` synchronous, which is what
  // lets the self-move flag above be a plain boolean.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    selfMoveRef.current = true;
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: FIT_MAX_ZOOM, animate: false });
    else map.setView(WORLD_CENTER, WORLD_ZOOM, { animate: false });
    selfMoveRef.current = false;
    onRoamRef.current?.(false);
  }, [bounds, fitNonce]);

  // (5) The selection ring. A heat blob is soft, so "which place did I just
  // click" needs an answer on the map itself, not only in the card. Drawn as
  // a circleMarker rather than a marker so it needs no icon asset and scales
  // with nothing — a fixed screen-radius ring, which is exactly the shape of
  // the hit test that produced it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) {
      map.removeLayer(markerRef.current);
      markerRef.current = null;
    }
    if (!selected) return;
    markerRef.current = L.circleMarker([selected.lat, selected.lng], {
      radius: 9,
      weight: 2,
      color: '#fff3d6',
      fillColor: '#ffe3a3',
      fillOpacity: 0.25,
      // The ring is a readout of the card, never a second click target — a
      // click on it must fall through to the map's own hit test.
      interactive: false,
    }).addTo(map);
  }, [selected]);

  // (6) Flying to a town chosen from the KEYBOARD list. Deliberately keyed on
  // `focusNonce` and not on `selected`: a map click must not yank the view
  // out from under the cursor that made it, and the list is the only other
  // way a town gets selected.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected || focusNonce === 0) return;
    selfMoveRef.current = true;
    map.setView([selected.lat, selected.lng], Math.max(map.getZoom(), 6), { animate: false });
    selfMoveRef.current = false;
    onRoamRef.current?.(true);
  }, [focusNonce, selected]);

  return (
    <div className={styles.wmHeatWrap}>
      <div
        ref={hostRef}
        className={styles.wmHeat}
        // Leaflet's keyboard handler makes the container itself focusable and
        // pannable with the arrow keys, so it needs a name.
        aria-label="Visitor density map"
      />
      {/* Only ever raised by a one-finger drag on a coarse pointer, so it
          never appears on a desktop. aria-live so it is not silent for a
          screen reader that just heard nothing happen. */}
      {touchHint && (
        <div className={styles.wmHeatHint} role="status" aria-live="polite">
          Use two fingers to pan the map
        </div>
      )}
    </div>
  );
}
