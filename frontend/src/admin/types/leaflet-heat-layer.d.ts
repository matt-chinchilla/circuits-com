// The `L.heatLayer` half of the leaflet.heat shim — a module augmentation, so
// it has to be a module file, which is exactly why the untyped-package
// declaration cannot share it. See `leaflet-heat.d.ts` for that side.
//
// Only what this codebase calls is declared. leaflet.heat's real surface is
// slightly wider (`addLatLng`, `setLatLngs`), and anything else needed later
// should be added here rather than cast at a call site.
import 'leaflet';

declare module 'leaflet' {
  /** `[lat, lng, intensity]`. The plugin also accepts `LatLng` objects with
   *  an `alt`; the triple form is what our payload already is. */
  type HeatLatLngTuple = [number, number, number];

  interface HeatMapOptions {
    /** Radius of each point's brush, in screen pixels. */
    radius?: number;
    /** Blur added AROUND that radius — the drawn footprint is radius + blur. */
    blur?: number;
    /** Alpha floor for a cell, applied after the division by `max`. */
    minOpacity?: number;
    /** The divisor every accumulated cell weight is scaled by. */
    max?: number;
    /** The zoom at which weights are taken at face value; below it they are
     *  divided by 2^(maxZoom - zoom). See HeatMapView for why we pin it. */
    maxZoom?: number;
    /** Stop position (0-1) -> CSS color. */
    gradient?: Record<number, string>;
  }

  interface HeatLayer extends Layer {
    setLatLngs(latlngs: HeatLatLngTuple[]): this;
    setOptions(options: HeatMapOptions): this;
    redraw(): this;
  }

  function heatLayer(latlngs: HeatLatLngTuple[], options?: HeatMapOptions): HeatLayer;
}
