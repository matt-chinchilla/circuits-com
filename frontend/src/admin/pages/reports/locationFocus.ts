// "Show me that place on the map" — the one contract between the Visiting
// Organizations panel and the map above it.
//
// Owner ask, 2026-08-31: a location in an organization's "Where & how" list
// should carry its country's flag and, on click, take the reader to that spot
// on whichever map is open. The two panels are SIBLINGS (both children of the
// Site Analytics tab), so the request travels up to the page and back down
// rather than through a shared store: it is one value in one direction, and a
// store would be a second source of truth about which place is selected — the
// map already owns that.
//
// Everything here is pure so the matching rules can be tested without a map.

import type { GeoCityRow } from '@admin/types/admin';

/** Just the three fields a focus needs. STRUCTURAL rather than an import of
 *  `OrgLocation` from the api service: that module pulls in axios, and this
 *  one is pure so its matching rules can be tested without a network layer.
 *  `OrgLocation` satisfies it structurally, so the call sites still type. */
export interface FocusableLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

/** A request to show one place. `nonce` is what makes a REPEAT click work:
 *  the value is otherwise identical, so an effect keyed on the object alone
 *  would fire once and then never again for the same location. */
export interface LocationFocus {
  /** ISO alpha-2. A location with no country cannot be pointed at. */
  country: string;
  region: string | null;
  city: string | null;
  nonce: number;
}

/** Case- and whitespace-insensitive, because the two sides reach the reader by
 *  different routes: the organization roll-up groups on the raw DB-IP strings
 *  and the town list has been through the district-suffix strip. "New York "
 *  and "new york" are the same place and must not miss each other. */
function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** The focus request for a location, or null when it carries no country —
 *  there is nothing to point at, and the caller renders plain text. */
export function focusFor(location: FocusableLocation, nonce: number): LocationFocus | null {
  if (!location.country) return null;
  return {
    country: location.country,
    region: location.region,
    city: location.city,
    nonce,
  };
}

/**
 * The town the density map should fly to for this request, or null.
 *
 * Matched on (country, region, city) — the same triple `townKey` uses, and for
 * the same reason: (city, region) alone folds London Ontario into London
 * England, and the global town list spans countries.
 *
 * REGION IS A TIEBREAK, NOT A GATE. The organization roll-up and the town list
 * are two different aggregations of the same page views, and a row can carry a
 * region on one side and null on the other; requiring both to agree would drop
 * a match the reader can plainly see in both lists. So a city+country match is
 * accepted, and the region only decides BETWEEN several of them — which is
 * exactly the Springfield case (Illinois vs Massachusetts).
 */
export function matchTown(towns: readonly GeoCityRow[], focus: LocationFocus): GeoCityRow | null {
  if (!focus.city) return null;
  const city = norm(focus.city);
  const country = norm(focus.country);
  const sameCity = towns.filter(
    (t) => norm(t.city) === city && (!t.country || norm(t.country) === country),
  );
  if (sameCity.length === 0) return null;
  if (sameCity.length === 1) return sameCity[0];
  const region = norm(focus.region);
  return sameCity.find((t) => norm(t.region) === region) ?? sameCity[0];
}
