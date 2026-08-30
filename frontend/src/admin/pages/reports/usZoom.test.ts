import { describe, it, expect } from 'vitest';
import { featureBounds, viewForBounds, MAX_STATE_ZOOM } from './usZoom';

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
});
