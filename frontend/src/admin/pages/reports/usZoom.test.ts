import { describe, it, expect } from 'vitest';
import { featureBounds, unionBounds, viewForBounds, MAX_STATE_ZOOM } from './usZoom';
import { mercatorProject } from './mapProjections';

const square = (name: string, x0: number, y0: number, x1: number, y1: number) => ({
  properties: { name },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  },
});

const twoIslands = {
  properties: { name: 'Islands' },
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 0],
        ],
      ],
      [
        [
          [90, 40],
          [100, 40],
          [100, 50],
          [90, 40],
        ],
      ],
    ],
  },
};

describe('featureBounds', () => {
  it('boxes polygons and unions multipolygon parts', () => {
    const { byName, frame } = featureBounds({
      features: [square('A', 0, 0, 100, 50), twoIslands],
    });
    expect(byName['A']).toEqual([0, 0, 100, 50]);
    expect(byName['Islands']).toEqual([0, 0, 100, 50]);
    expect(frame).toEqual([0, 0, 100, 50]);
  });

  it('skips features without a name or geometry rather than throwing', () => {
    const { byName } = featureBounds({
      features: [{ properties: {} }, { properties: { name: 'NoGeom' } }, square('B', 5, 5, 6, 6)],
    });
    expect(Object.keys(byName)).toEqual(['B']);
  });

  it('accumulates a name that appears on several features', () => {
    // Ireland lists Cork twice, county and city. Letting the last one win
    // would frame half the place on a click.
    const { byName } = featureBounds({
      features: [square('Cork', 0, 0, 10, 10), square('Cork', 40, 20, 50, 30)],
    });
    expect(byName['Cork']).toEqual([0, 0, 50, 30]);
  });

  it('measures in PROJECTED space when a projection is supplied', () => {
    // A country asset ships lat/lng and the geo component projects it, so a
    // box taken in raw degrees describes a rectangle the renderer never
    // draws. Germany is the worked case: mercator compresses its width
    // (degrees -> radians) and stretches its height.
    const germany = square('Germany', 5.87, 47.27, 15.04, 55.06);
    const { byName } = featureBounds({ features: [germany] }, mercatorProject);
    const box = byName['Germany'];
    const [swX, swY] = mercatorProject([5.87, 47.27]);
    const [neX, neY] = mercatorProject([15.04, 55.06]);
    expect(box[0]).toBeCloseTo(swX, 10);
    expect(box[2]).toBeCloseTo(neX, 10);
    // y is DOWN after projection, so the NORTH edge is the box's minimum.
    expect(box[1]).toBeCloseTo(neY, 10);
    expect(box[3]).toBeCloseTo(swY, 10);
  });

  it('leaves a planar asset alone by default', () => {
    const { byName } = featureBounds({ features: [square('A', 0, 0, 100, 50)] });
    expect(byName['A']).toEqual([0, 0, 100, 50]);
  });
});

describe('unionBounds', () => {
  it('is the smallest box containing every part', () => {
    // England resolves to 150 district polygons; a click frames their union,
    // not whichever one was under the cursor.
    expect(
      unionBounds([
        [10, 10, 20, 20],
        [-5, 30, 0, 40],
        [15, 5, 25, 12],
      ]),
    ).toEqual([-5, 5, 25, 40]);
  });

  it('passes a single box straight through', () => {
    expect(unionBounds([[1, 2, 3, 4]])).toEqual([1, 2, 3, 4]);
  });

  it('is null for nothing, so a caller cannot zoom to an empty frame', () => {
    expect(unionBounds([])).toBeNull();
  });
});

describe('viewForBounds', () => {
  const frame: [number, number, number, number] = [0, 0, 1000, 500];

  it('centers on the state and zooms by the fit ratio', () => {
    // A 100x50 state in a 1000x500 frame shown in a 1000x500 plot: the frame
    // fits at 1, the state at 10, margined to 8.2.
    const v = viewForBounds([200, 100, 300, 150], frame, 1000, 500);
    expect(v.center).toEqual([250, 125]);
    expect(v.zoom).toBeCloseTo(8.2, 5);
  });

  it('letterboxes on the tight axis like ECharts does', () => {
    // Tall state in a wide plot: height is the binding axis for the state,
    // width for nothing — fitState = 200/100, fitFrame = 200/500.
    const v = viewForBounds([0, 0, 50, 100], frame, 1000, 200);
    expect(v.zoom).toBeCloseTo((0.82 * (200 / 100)) / (200 / 500), 5);
  });

  it('never zooms below the auto-fit and never past the cap', () => {
    expect(viewForBounds([0, 0, 1000, 500], frame, 800, 300).zoom).toBe(1);
    expect(viewForBounds([10, 10, 11, 11], frame, 1000, 500).zoom).toBe(MAX_STATE_ZOOM);
  });

  it('works in radian-scale space, where the whole world is 6.28 wide', () => {
    // REGRESSION GUARD: the degeneracy floor used to be an absolute 1 unit,
    // which is invisible in the US asset's ~900-unit planar frame and
    // catastrophic in projected radians — every region would be clamped to a
    // rectangle bigger than the country and every click would return zoom 1.
    const radianFrame: [number, number, number, number] = [-0.2, -0.2, 0.2, 0.2];
    const v = viewForBounds([-0.02, -0.02, 0.02, 0.02], radianFrame, 1000, 500);
    expect(v.zoom).toBeGreaterThan(5);
    expect(v.center).toEqual([0, 0]);
  });
});
