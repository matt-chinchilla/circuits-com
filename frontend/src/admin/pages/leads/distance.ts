// The Location column's distance render + filter buckets, in one testable
// home. The SERVER computes and stores miles (HQ → ZIP centroid,
// services/lead_distance.py); this module only formats and maps bucket
// choices onto the list endpoint's min_miles/max_miles params.

/** `2478.6` → `"2479 miles"`; under 10 miles keep the tenths (`"8.3 miles"`)
 *  — at centroid resolution a whole-mile round would render every same-town
 *  lead as an identical "0 miles" / "1 miles". */
export function formatMiles(miles: number): string {
  if (miles < 10) return `${miles.toFixed(1)} miles`;
  return `${Math.round(miles)} miles`;
}

export type DistanceFilterKey = 'all' | '10' | '25' | '50' | '100' | '250' | '500' | '1000' | 'far';

export const DISTANCE_CHOICES: ReadonlyArray<{ key: DistanceFilterKey; label: string }> = [
  { key: 'all', label: 'Any distance' },
  { key: '10', label: 'Within 10 miles' },
  { key: '25', label: 'Within 25 miles' },
  { key: '50', label: 'Within 50 miles' },
  { key: '100', label: 'Within 100 miles' },
  { key: '250', label: 'Within 250 miles' },
  { key: '500', label: 'Within 500 miles' },
  { key: '1000', label: 'Within 1000 miles' },
  { key: 'far', label: 'Beyond 1000 miles' },
];

/** Bucket → query params. 'all' contributes nothing; 'far' is min-only. */
export function distanceParams(key: DistanceFilterKey): { min_miles?: number; max_miles?: number } {
  if (key === 'all') return {};
  if (key === 'far') return { min_miles: 1000 };
  return { max_miles: Number(key) };
}
