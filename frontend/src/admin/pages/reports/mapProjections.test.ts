import { describe, it, expect } from 'vitest';
import statesGeo from '@admin/components/charts/us-states-albers.geo.json';
import {
  albersUsaProject,
  naturalEarth1Project,
  naturalEarth1Unproject,
  usPlanarProject,
  usPlanarUnproject,
} from './mapProjections';

interface StateFeature {
  properties: { name: string };
  geometry: { type: string; coordinates: number[][][] | number[][][][] };
}

type Ring = number[][];

/** Every ring of one state in the committed asset, grouped by polygon so a
 *  hole cancels its own outer ring rather than another polygon's. */
function statePolygons(name: string): Ring[][] {
  const feature = (statesGeo as unknown as { features: StateFeature[] }).features.find(
    (f) => f.properties.name === name,
  );
  if (!feature) throw new Error(`no feature named ${name}`);
  return feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates as Ring[]]
    : (feature.geometry.coordinates as Ring[][]);
}

/** Even-odd ray cast. Rings are planar and already closed. */
function ringContains(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function stateContains(name: string, x: number, y: number): boolean {
  return statePolygons(name).some((rings) =>
    rings.reduce((acc, ring) => (ringContains(ring, x, y) ? !acc : acc), false),
  );
}

describe('naturalEarth1', () => {
  it('round-trips a lat/lng grid to within 1e-6 degrees', () => {
    for (let lat = -85; lat <= 85; lat += 5) {
      for (let lng = -180; lng <= 180; lng += 15) {
        const [rlng, rlat] = naturalEarth1Unproject(naturalEarth1Project([lng, lat]));
        expect(rlng, `lng ${lng},${lat}`).toBeCloseTo(lng, 6);
        expect(rlat, `lat ${lng},${lat}`).toBeCloseTo(lat, 6);
      }
    }
  });

  it('emits ECharts screen order: north is a SMALLER y than south', () => {
    // The whole reason the raw d3 y is negated. Get this backwards and the
    // world renders upside down.
    const oslo = naturalEarth1Project([10.75, 59.91]);
    const capeTown = naturalEarth1Project([18.42, -33.92]);
    expect(oslo[1]).toBeLessThan(capeTown[1]);
    const origin = naturalEarth1Project([0, 0]);
    expect(origin[0]).toBe(0);
    expect(origin[1]).toBeCloseTo(0, 12);
  });

  it('keeps x monotonic eastward and compresses the high latitudes', () => {
    expect(naturalEarth1Project([-120, 0])[0]).toBeLessThan(naturalEarth1Project([0, 0])[0]);
    expect(naturalEarth1Project([0, 0])[0]).toBeLessThan(naturalEarth1Project([120, 0])[0]);
    // A 60-degree span of longitude is narrower at 70N than at the equator —
    // the property equirectangular lacks, and the reason for this projection.
    const atEquator = naturalEarth1Project([60, 0])[0] - naturalEarth1Project([0, 0])[0];
    const atHighLat = naturalEarth1Project([60, 70])[0] - naturalEarth1Project([0, 70])[0];
    expect(atHighLat).toBeLessThan(atEquator);
  });
});

// The committed us-states-albers.geo.json frame: 975 x 610, with the Alaska
// inset bottom-left and Hawaii to its right. Bounds below are read off that
// asset, so a drifting projection fails here before it ships crooked dots.
describe('albersUsaProject', () => {
  const inFrame = (p: [number, number] | null): [number, number] => {
    expect(p).not.toBeNull();
    return p as [number, number];
  };

  it('lands each city inside its own state, per the committed asset', () => {
    // The real invariant: the projection and us-states-albers.geo.json must
    // describe the SAME planar frame. Asserting against the asset's own state
    // bounds catches a drifting constant that a hand-written number would not.
    for (const [city, state, lngLat] of [
      ['NYC', 'New York', [-74.006, 40.713]],
      ['LA', 'California', [-118.244, 34.052]],
      ['Chicago', 'Illinois', [-87.63, 41.878]],
      ['Houston', 'Texas', [-95.369, 29.76]],
      ['Miami', 'Florida', [-80.192, 25.774]],
      ['Seattle', 'Washington', [-122.332, 47.606]],
      ['Anchorage', 'Alaska', [-149.9, 61.218]],
      ['Juneau', 'Alaska', [-134.42, 58.3]],
      ['Honolulu', 'Hawaii', [-157.858, 21.315]],
      ['Hilo', 'Hawaii', [-155.089, 19.706]],
    ] as Array<[string, string, [number, number]]>) {
      const [x, y] = inFrame(albersUsaProject(lngLat));
      expect(stateContains(state, x, y), `${city} (${x}, ${y}) inside ${state}`).toBe(true);
    }
  });

  it('reproduces d3-geo albersUsa to the pixel at scale(1300)/translate(487.5,305)', () => {
    // Pinned against d3's own output for the same three zones. Polygon
    // containment alone tolerates a degree of drift in the standard
    // parallels; these do not.
    const cases: Array<[string, [number, number], [number, number]]> = [
      ['NYC', [-74.006, 40.713], [869.7177153, 215.7360670]],
      ['LA', [-118.244, 34.052], [86.8056261, 363.1220297]],
      ['Anchorage', [-149.9, 61.218], [112.2786174, 544.2786413]],
      ['Honolulu', [-157.858, 21.315], [266.9669451, 549.0078907]],
    ];
    for (const [name, lngLat, expected] of cases) {
      const [x, y] = inFrame(albersUsaProject(lngLat));
      expect(x, `${name} x`).toBeCloseTo(expected[0], 5);
      expect(y, `${name} y`).toBeCloseTo(expected[1], 5);
    }
  });

  it('runs x eastward and y southward', () => {
    const la = inFrame(albersUsaProject([-118.244, 34.052]));
    const chicago = inFrame(albersUsaProject([-87.63, 41.878]));
    const nyc = inFrame(albersUsaProject([-74.006, 40.713]));
    expect(la[0]).toBeLessThan(chicago[0]);
    expect(chicago[0]).toBeLessThan(nyc[0]);

    const seattle = inFrame(albersUsaProject([-122.332, 47.606]));
    const houston = inFrame(albersUsaProject([-95.369, 29.76]));
    expect(seattle[1]).toBeLessThan(houston[1]);
  });

  it('drops Alaska into the bottom-left inset', () => {
    for (const lngLat of [
      [-149.9, 61.218], // Anchorage
      [-134.42, 58.3], // Juneau
    ] as Array<[number, number]>) {
      const [x, y] = inFrame(albersUsaProject(lngLat));
      expect(x).toBeLessThan(400);
      expect(y).toBeGreaterThan(450);
    }
  });

  it('drops Hawaii into its own inset, to the right of Alaska', () => {
    const honolulu = inFrame(albersUsaProject([-157.858, 21.315]));
    const hilo = inFrame(albersUsaProject([-155.089, 19.706]));
    const anchorage = inFrame(albersUsaProject([-149.9, 61.218]));
    for (const [x, y] of [honolulu, hilo]) {
      // Matches the Hawaii features in the committed asset (x 216..332).
      expect(x).toBeGreaterThan(209);
      expect(x).toBeLessThan(340);
      expect(y).toBeGreaterThan(450);
    }
    expect(honolulu[0]).toBeGreaterThan(anchorage[0]);
  });

  it('returns null outside all three zones', () => {
    for (const lngLat of [
      [-40, 40], // mid-Atlantic
      [-30, 30],
      [-0.128, 51.507], // London
      [139.69, 35.69], // Tokyo
      [-140, -20], // South Pacific
    ] as Array<[number, number]>) {
      expect(albersUsaProject(lngLat)).toBeNull();
    }
  });
});

describe('usPlanar', () => {
  it('is the identity, and copies rather than aliasing the input', () => {
    const p: [number, number] = [869.7, 215.7];
    expect(usPlanarProject(p)).toEqual(p);
    expect(usPlanarProject(p)).not.toBe(p);
    expect(usPlanarUnproject(usPlanarProject(p))).toEqual(p);
  });
});
