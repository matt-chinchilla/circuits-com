import { describe, expect, it } from 'vitest';
import { countryName, flagEmoji } from '@admin/services/country';
import {
  COUNTRY_PROJECTION,
  MAP_BOX,
  MAP_NAME,
  US_MAP_NAME,
  WORLD_FRAME_ASPECT,
  buildCountryOption,
  buildUsOption,
  buildWorldOption,
} from './mapOptions';
import type { CityPoint, CountryRow, RegionPaint, UsCityRow, UsStateRow } from './mapOptions';
import { binColorFor, buildBins } from './viewershipBins';
import { naturalEarth1Project } from './mapProjections';
import { frameAspect } from './usZoom';
import world110 from '@admin/components/charts/world-110m.geo.json';

/** Only what the frame math reads off the committed world asset. */
interface WorldAsset {
  features: Array<{
    properties?: { iso?: string };
    geometry?: { type?: string; coordinates?: unknown };
  }>;
}

// These pin the SHIPPED shape of the two map options — every one of them is a
// fix that was found by hand in a live browser and would otherwise regress
// silently, because nothing in this repo renders ECharts in a test:
//   roam            — the world view ignored the wheel while the US obeyed it.
//   no visualMap    — the in-canvas legend painted over the states when zoomed.
//   per-item fills  — removing the visualMap is what made them load-bearing.
//   emphasis labels — hovering a state stamped its name on the map.
//   geo + geoIndex  — a scatter cannot bind to a map series' own coord system.

// ── Fixtures ────────────────────────────────────────────────────────────────
// Small but shaped like the real payload: a heavy-tailed country list (one
// giant, one middling, two singletons) so the bins actually spread.
const COUNTRIES: CountryRow[] = [
  { code: 'US', views: 533, visitors: 210 },
  { code: 'DE', views: 12, visitors: 9 },
  { code: 'BR', views: 3, visitors: 3 },
  { code: 'JP', views: 1, visitors: 1 },
];
const WORLD_BINS = buildBins(533);

const STATES: UsStateRow[] = [
  { name: 'New York', views: 88, visitors: 40 },
  { name: 'Texas', views: 9, visitors: 6 },
  { name: 'Vermont', views: 1, visitors: 1 },
];
const US_BINS = buildBins(88);

const ALBANY: UsCityRow = {
  city: 'Albany',
  region: 'New York',
  lat: 42.65,
  lng: -73.76,
  views: 7,
  visitors: 4,
};
const AUSTIN: UsCityRow = {
  city: 'Austin',
  region: 'Texas',
  lat: 30.27,
  lng: -97.74,
  views: 2,
  visitors: 2,
};
const CITY_POINTS: CityPoint[] = [ALBANY, AUSTIN].map((row, i) => ({
  name: `${row.city}, ${row.region}`,
  value: [800 + i, 180 + i, row.views],
  symbolSize: 8 + i,
  itemStyle: { color: binColorFor(row.views, US_BINS) },
  row,
}));

/** The empty-land slate and the visited-region orchid, quoted from mapOptions.
 *  Both are measured values (see the comments there) — pinning them here is
 *  what makes a silent retint show up as a failed test rather than a washed
 *  out map nobody notices. */
const LAND_NO_DATA = '#2a3550';
const VISITED_BORDER = '#b083bd';

// ── Just enough of the option shape to assert on ────────────────────────────
interface ItemStyle {
  areaColor?: string;
  borderColor?: string;
  borderWidth?: number;
  color?: string;
}
interface DataItem {
  name?: string;
  value?: number;
  itemStyle?: ItemStyle;
  row?: UsCityRow;
}
interface RegionStyle {
  name?: string;
  itemStyle?: ItemStyle;
  emphasis?: { label?: { show?: boolean }; itemStyle?: ItemStyle };
}

interface MapNode {
  regions?: RegionStyle[];
  type?: string;
  map?: string;
  nameProperty?: string;
  geoIndex?: number;
  coordinateSystem?: string;
  symbol?: string;
  roam?: boolean;
  scaleLimit?: { min?: number; max?: number };
  projection?: { project?: unknown; unproject?: unknown };
  emphasis?: { label?: { show?: boolean }; itemStyle?: ItemStyle; scale?: number };
  label?: { show?: boolean };
  select?: { disabled?: boolean };
  itemStyle?: ItemStyle;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  preserveAspect?: boolean | string;
  roamTrigger?: string;
  data?: DataItem[];
}
interface Opt {
  backgroundColor?: string;
  tooltip?: { trigger?: string; formatter?: (p: unknown) => string };
  geo?: MapNode;
  series?: MapNode[];
}

const world = () =>
  buildWorldOption({ countries: COUNTRIES, bins: WORLD_BINS }) as unknown as Opt;
const us = () =>
  buildUsOption({
    stateRows: STATES,
    cityPoints: CITY_POINTS,
    bins: US_BINS,
  }) as unknown as Opt;

/** Everything MAP_BOX contributes to a view: the four insets AND the two
 *  options that make the fit aspect-preserving. Compared against MAP_BOX
 *  itself, so a key added there has to reach BOTH views or these fail. */
const fits = (node: MapNode | undefined) => ({
  top: node?.top,
  bottom: node?.bottom,
  left: node?.left,
  right: node?.right,
  preserveAspect: node?.preserveAspect,
  roamTrigger: node?.roamTrigger,
});

describe('buildWorldOption', () => {
  it('is one bare map series over the world asset', () => {
    const series = world().series ?? [];
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('map');
    expect(series[0].map).toBe(MAP_NAME);
    expect(series[0].nameProperty).toBe('iso');
    expect(world().geo).toBeUndefined();
  });

  it('projects through naturalEarth1 in both directions', () => {
    const projection = world().series?.[0].projection;
    expect(typeof projection?.project).toBe('function');
    expect(typeof projection?.unproject).toBe('function');
  });

  it('roams, under the same ceiling the US view uses', () => {
    const series = world().series?.[0];
    expect(series?.roam).toBe(true);
    expect(series?.scaleLimit).toBeDefined();
    expect(series?.scaleLimit?.min).toBe(1);
    expect(series?.scaleLimit?.max).toBeGreaterThan(1);
  });

  it('declares no visualMap — the legend is DOM below the canvas', () => {
    expect('visualMap' in (buildWorldOption({ countries: COUNTRIES, bins: WORLD_BINS }) as object)).toBe(
      false,
    );
  });

  it('colors every country off the shared bins, ringed by the visited edge', () => {
    const data = world().series?.[0].data ?? [];
    expect(data).toHaveLength(COUNTRIES.length);
    data.forEach((item, i) => {
      expect(item.name).toBe(COUNTRIES[i].code);
      expect(item.value).toBe(COUNTRIES[i].views);
      expect(item.itemStyle?.areaColor).toBe(binColorFor(COUNTRIES[i].views, WORLD_BINS));
      // The same orchid edge the country views carry (2026-08-31): with empty
      // land lifted to a readable slate, the ring is what keeps a small
      // 1-view country louder than the ground around it.
      expect(item.itemStyle?.borderColor).toBe(VISITED_BORDER);
      expect(item.itemStyle?.borderWidth).toBe(0.9);
    });
    // The whole point of dropping the visualMap: no item may be left uncolored.
    expect(data.every((d) => typeof d.itemStyle?.areaColor === 'string')).toBe(true);
  });

  it('never stamps a country name on the map on hover', () => {
    expect(world().series?.[0].emphasis?.label?.show).toBe(false);
  });

  it('keeps unvisited land honestly empty-slate and unselectable', () => {
    const series = world().series?.[0];
    expect(series?.itemStyle?.areaColor).toBe(LAND_NO_DATA);
    expect(series?.select?.disabled).toBe(true);
  });

  it('sits in the shared map box', () => {
    expect(fits(world().series?.[0])).toEqual(MAP_BOX);
  });

  it('still builds — with no data and no visualMap — for an empty world', () => {
    const empty = buildWorldOption({ countries: [], bins: buildBins(2) }) as unknown as Opt;
    expect(empty.series?.[0].data).toEqual([]);
    expect('visualMap' in (empty as object)).toBe(false);
    expect(empty.series?.[0].itemStyle?.areaColor).toBe(LAND_NO_DATA);
  });
});

describe('buildWorldOption tooltip', () => {
  const format = (p: unknown) => world().tooltip?.formatter?.(p) ?? '';

  it('reports views and visitors for a country in the window', () => {
    expect(format({ name: 'US', value: 533 })).toBe(
      `${flagEmoji('US')} ${countryName('US')}<br/>533 views · 210 visitors`,
    );
  });

  it('singularizes a lone view', () => {
    expect(format({ name: 'JP', value: 1 })).toContain('1 view · 1 visitor');
  });

  it('drops the visitor clause for a country with no row behind it', () => {
    const out = format({ name: 'FR', value: 4 });
    expect(out).toContain('4 views');
    expect(out).not.toContain('visitor');
  });

  it('reads a missing or NaN value as zero rather than printing NaN', () => {
    expect(format({ name: 'FR' })).toContain('0 views');
    expect(format({ name: 'FR', value: Number.NaN })).toContain('0 views');
  });

  it('renders nothing for a nameless hover', () => {
    expect(format({ value: 9 })).toBe('');
  });
});

describe('buildUsOption', () => {
  it('is a geo component with a map series bound by geoIndex and a geo scatter', () => {
    const opt = us();
    expect(opt.geo?.map).toBe(US_MAP_NAME);
    expect(opt.geo?.nameProperty).toBe('name');

    const series = opt.series ?? [];
    expect(series).toHaveLength(2);
    expect(series[0].type).toBe('map');
    expect(series[0].geoIndex).toBe(0);
    expect(series[0].map).toBeUndefined(); // it borrows the geo component's

    // A scatter cannot address a map series' private coordinate system — this
    // binding is the whole reason the US view carries a geo component at all.
    expect(series[1].type).toBe('scatter');
    expect(series[1].coordinateSystem).toBe('geo');
    expect(series[1].geoIndex).toBe(0);
  });

  it('takes the identity projection, NOT no projection (the asset is planar)', () => {
    const projection = us().geo?.projection;
    expect(typeof projection?.project).toBe('function');
    expect(typeof projection?.unproject).toBe('function');
  });

  it('roams on the geo component', () => {
    expect(us().geo?.roam).toBe(true);
    expect(us().geo?.scaleLimit).toBeDefined();
    expect(us().geo?.scaleLimit?.min).toBe(1);
    expect(us().geo?.scaleLimit?.max).toBeGreaterThan(1);
  });

  it('declares no visualMap — the legend is DOM below the canvas', () => {
    const opt = buildUsOption({
      stateRows: STATES,
      cityPoints: CITY_POINTS,
      bins: US_BINS,
    }) as object;
    expect('visualMap' in opt).toBe(false);
  });

  it('paints the states on geo.regions, which is the only place that renders', () => {
    // REGRESSION GUARD (shipped 2026-08-30, caught on the live canvas): a
    // `series-map` bound through `geoIndex` hands region rendering to the geo
    // component, so per-item `itemStyle` on the SERIES DATA is silently
    // ignored and every state paints the empty-land navy. The fills must be
    // on `geo.regions`.
    const regions = us().geo?.regions ?? [];
    expect(regions).toHaveLength(STATES.length);
    regions.forEach((region, i) => {
      expect(region.name).toBe(STATES[i].name);
      expect(region.itemStyle?.areaColor).toBe(binColorFor(STATES[i].views, US_BINS));
      expect(region.itemStyle?.borderColor).toBe(VISITED_BORDER);
      expect(region.itemStyle?.borderWidth).toBe(0.9);
    });
  });

  it('keeps the state VALUES on the series, so tooltips still have numbers', () => {
    const data = us().series?.[0].data ?? [];
    expect(data).toHaveLength(STATES.length);
    data.forEach((item, i) => {
      expect(item.name).toBe(STATES[i].name);
      expect(item.value).toBe(STATES[i].views);
    });
  });

  it('suppresses the hover label on the geo AND on the map series', () => {
    // The geo component's no-label emphasis does NOT reach the series: with
    // only one of these, hovering a state stamps its name on the map.
    expect(us().geo?.emphasis?.label?.show).toBe(false);
    expect(us().series?.[0].emphasis?.label?.show).toBe(false);
    expect(us().series?.[1].label?.show).toBe(false);
  });

  it('disables select on the map series — a zoom click must not park a state gold', () => {
    // REGRESSION GUARD (found 2026-08-30 on the live canvas): the click that
    // zooms a state was ALSO selecting it on the series — the geo's
    // select.disabled does not reach a geoIndex-bound series — leaving it in
    // ECharts' default select style: pale gold fill, grey name stamp.
    expect(us().series?.[0].select?.disabled).toBe(true);
  });

  it('suppresses the hover label on every REGION too', () => {
    // REGRESSION GUARD (found 2026-08-30 on the live canvas): after the
    // click-to-zoom's merge-setOption touched the geo, hovering a state
    // stamped its name in ECharts' default grey even with the component and
    // series suppression above in place. Region-level emphasis survives that
    // path, and repeats the hover fill so the highlight keeps the ramp's
    // pale-gold language instead of ECharts' default.
    const regions = us().geo?.regions ?? [];
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      expect(region.emphasis?.label?.show).toBe(false);
      expect(region.emphasis?.itemStyle?.areaColor).toBe('#ffe3a3');
    }
  });

  it('keeps each dot on its own bin color and carries its source row', () => {
    const data = us().series?.[1].data ?? [];
    expect(data).toHaveLength(CITY_POINTS.length);
    expect(data[0].itemStyle?.color).toBe(binColorFor(ALBANY.views, US_BINS));
    expect(data[1].itemStyle?.color).toBe(binColorFor(AUSTIN.views, US_BINS));
    // The row rides along so a click reads the town straight off params.data —
    // matching back by name would break the moment two states share a town.
    expect(data[0].row).toBe(ALBANY);
    expect(data[1].row).toBe(AUSTIN);
  });

  it('rings the dots rather than tinting them, and shares the map box', () => {
    const scatter = us().series?.[1];
    expect(scatter?.symbol).toBe('circle');
    expect(scatter?.itemStyle?.borderWidth).toBe(1);
    expect(scatter?.emphasis?.itemStyle?.borderColor).toBeTruthy();
    expect(fits(us().geo)).toEqual(MAP_BOX);
  });

  it('still builds for a state list that has not collected anything yet', () => {
    const empty = buildUsOption({
      stateRows: [],
      cityPoints: [],
      bins: buildBins(2),
    }) as unknown as Opt;
    expect(empty.series?.[0].data).toEqual([]);
    expect(empty.series?.[1].data).toEqual([]);
    expect(empty.geo?.itemStyle?.areaColor).toBe(LAND_NO_DATA);
    expect('visualMap' in (empty as object)).toBe(false);
  });
});

describe('buildUsOption tooltip', () => {
  const format = (p: unknown) => us().tooltip?.formatter?.(p) ?? '';

  it('reports views and visitors for a state in the window', () => {
    expect(format({ name: 'New York', value: 88 })).toBe(
      'New York<br/>88 views · 40 visitors',
    );
  });

  it('says so plainly for a state with no row behind it', () => {
    expect(format({ name: 'Wyoming' })).toBe('Wyoming<br/>No visits recorded');
  });

  it('reads a dot off its third value, not off the state rows', () => {
    expect(format({ seriesType: 'scatter', name: 'Albany, New York', data: { value: [800, 180, 7] } })).toBe(
      'Albany, New York<br/>7 views',
    );
    expect(format({ seriesType: 'scatter', name: 'Austin, Texas', data: { value: [801, 181, 1] } })).toBe(
      'Austin, Texas<br/>1 view',
    );
  });

  it('renders nothing for a nameless hover', () => {
    expect(format({ seriesType: 'scatter', data: { value: [0, 0, 3] } })).toBe('');
  });
});

// ── buildCountryOption — the generalized drill-down ─────────────────────────
// buildUsOption is one CALL of this, so everything above already exercises the
// shared shape. What is left to pin is the part the United States can never
// reach: a DB-IP subdivision that owns SEVERAL Natural Earth polygons.

describe('buildCountryOption for a country whose regions span many polygons', () => {
  // Italy: DB-IP reports "Lazio", Natural Earth ships its five provinces.
  const LAZIO: RegionPaint[] = [
    { feature: 'Rome', label: 'Lazio', views: 40, visitors: 21 },
    { feature: 'Latina', label: 'Lazio', views: 40, visitors: 21 },
    { feature: 'Naples', label: 'Campania', views: 3, visitors: 3 },
  ];
  const BINS = buildBins(40);
  const italy = () =>
    buildCountryOption({
      mapName: 'admin1:IT',
      projection: COUNTRY_PROJECTION,
      regions: LAZIO,
      cityPoints: [],
      bins: BINS,
    }) as unknown as Opt;

  it('paints one geo.region per POLYGON, all carrying their region colour', () => {
    const regions = italy().geo?.regions ?? [];
    expect(regions.map((r) => r.name)).toEqual(['Rome', 'Latina', 'Naples']);
    expect(regions[0].itemStyle?.areaColor).toBe(binColorFor(40, BINS));
    expect(regions[1].itemStyle?.areaColor).toBe(regions[0].itemStyle?.areaColor);
    expect(regions[2].itemStyle?.areaColor).toBe(binColorFor(3, BINS));
  });

  it('registers the country asset by its own map name', () => {
    expect(italy().geo?.map).toBe('admin1:IT');
    expect(italy().geo?.nameProperty).toBe('name');
  });

  it('projects through mercator in both directions', () => {
    expect(typeof italy().geo?.projection?.project).toBe('function');
    expect(typeof italy().geo?.projection?.unproject).toBe('function');
  });

  it('names the SUBDIVISION in the tooltip, not the polygon under the cursor', () => {
    // Hit-testing reports "Latina"; the reader asked about Lazio. Without
    // this the drill-down would report Italian provinces and British
    // districts the API never mentioned and the rank rail never lists.
    const format = (p: unknown) => italy().tooltip?.formatter?.(p) ?? '';
    expect(format({ name: 'Latina', value: 40 })).toBe('Lazio<br/>40 views · 21 visitors');
    expect(format({ name: 'Rome', value: 40 })).toBe('Lazio<br/>40 views · 21 visitors');
  });

  it('says so plainly for a polygon no subdivision claimed', () => {
    expect(italy().tooltip?.formatter?.({ name: 'Milan' })).toBe('Milan<br/>No visits recorded');
  });

  it('still builds for a country whose regions found no polygons at all', () => {
    const empty = buildCountryOption({
      mapName: 'admin1:LK',
      projection: COUNTRY_PROJECTION,
      regions: [],
      cityPoints: [],
      bins: buildBins(2),
    }) as unknown as Opt;
    expect(empty.geo?.regions).toEqual([]);
    expect(empty.series?.[0].data).toEqual([]);
    expect(empty.geo?.itemStyle?.areaColor).toBe(LAND_NO_DATA);
  });
});

describe('buildUsOption is buildCountryOption, wired to the albers asset', () => {
  it('produces the same option as the generalized builder given the same rows', () => {
    // The US path must not fork: it is the one country whose asset is
    // pre-projected, and that is ALL that differs.
    const direct = buildCountryOption({
      mapName: US_MAP_NAME,
      projection: {
        project: (p: [number, number]) => [p[0], p[1]],
        unproject: (p: [number, number]) => [p[0], p[1]],
      },
      regions: STATES.map((s) => ({
        feature: s.name,
        label: s.name,
        views: s.views,
        visitors: s.visitors,
      })),
      cityPoints: CITY_POINTS,
      bins: US_BINS,
    }) as unknown as Opt;
    expect(JSON.stringify(direct.geo?.regions)).toBe(JSON.stringify(us().geo?.regions));
    expect(JSON.stringify(direct.series?.[0].data)).toBe(JSON.stringify(us().series?.[0].data));
  });
});

// ── The geometry guard (2026-08-31) ─────────────────────────────────────────
// The bug these pin: ECharts fits geography to the plot rect and STRETCHES it
// to fill — it never letterboxes on its own. Measured on the live canvas by
// scanning the drawn ink's bounding box, the ink aspect equalled the plot-rect
// aspect at every viewport, so the world (true 2.298:1) drew at 0.83:1 on a
// 320px phone and 1.93:1 on a 1440px desktop. Nothing in the option said so;
// the only tell was the shape of the continents.
describe('the fit preserves the geography, at every box shape', () => {
  it('asks ECharts to CONTAIN rather than fill', () => {
    // `true` is contain-and-centre; `'cover'` would crop the map to the box,
    // which is the same class of lie in the other direction — the reader would
    // lose whole countries off the edges without being told.
    expect(MAP_BOX.preserveAspect).toBe(true);
  });

  it('hands the whole canvas back to roam, since the fit now leaves water', () => {
    // Roam is hit-tested against the FITTED rect (echarts MapDraw uses
    // `coordinateSystem.containPoint`), so the open water letterboxing creates
    // would otherwise swallow the wheel and the drag over its own bands.
    expect(MAP_BOX.roamTrigger).toBe('global');
  });

  it('carries it on the world series AND on both drill-down geos', () => {
    // One object spread into both builders is the whole guarantee: a fix that
    // reached only the view someone happened to be looking at is how this
    // shipped warped in the first place.
    expect(fits(world().series?.[0])).toEqual(MAP_BOX);
    expect(fits(us().geo)).toEqual(MAP_BOX);
    expect(
      fits(
        (
          buildCountryOption({
            mapName: 'admin1:GB',
            projection: COUNTRY_PROJECTION,
            regions: [{ feature: 'England', label: 'England', views: 4, visitors: 2 }],
            cityPoints: [],
            bins: buildBins(4),
          }) as unknown as Opt
        ).geo,
      ),
    ).toEqual(MAP_BOX);
  });

  it('publishes a world frame ratio that IS the committed asset\u2019s own', () => {
    // WORLD_FRAME_ASPECT is what the panel hands the SCSS as `--wm-aspect`,
    // so the sea plate and the map inside it are one measurement. Re-derived
    // here from the shipped geojson under the shipped projection — swap the
    // asset for a different world and this fails rather than quietly leaving
    // the plate the wrong shape.
    //
    // Antarctica is excluded because the panel excludes it (it reaches -90 and
    // costs a third of the vertical budget to draw a landmass that will never
    // send a page view). Keeping it would make the true ratio 1.93, and the
    // difference between the two is exactly the size of the mistake available
    // here.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const visit = (coords: unknown, depth: number): void => {
      if (depth === 0) {
        const [x, y] = naturalEarth1Project(coords as [number, number]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        return;
      }
      for (const part of coords as unknown[]) visit(part, depth - 1);
    };
    for (const f of (world110 as WorldAsset).features) {
      if (f.properties?.iso === 'AQ') continue;
      if (f.geometry?.type === 'Polygon') visit(f.geometry.coordinates, 2);
      else if (f.geometry?.type === 'MultiPolygon') visit(f.geometry.coordinates, 3);
    }
    expect(frameAspect([minX, minY, maxX, maxY])).toBeCloseTo(WORLD_FRAME_ASPECT, 4);
  });
});
