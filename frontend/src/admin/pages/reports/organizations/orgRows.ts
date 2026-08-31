import { countryName } from '@admin/services/country';
import type { OrgKind, VisitorOrganization, OrgLocation } from '@admin/services/adminApi';
import { plural } from '../cityIntel';

/** The chip set. `all` is not a kind the API returns — it is the absence of a
 *  filter, and it sits last because the panel's whole point is the first one. */
export type OrgFilter = OrgKind | 'all' | 'matched';

// `matched` leads: an organization already on the call list is the most
// actionable row the panel can show, so it is the first chip and the first
// question — "which of my prospects have been here?"
export const ORG_FILTERS: OrgFilter[] = ['matched', 'corporate', 'isp', 'hosting', 'all'];

/** Chip and badge wording. "Company" rather than "Corporate" because the
 *  owner's question was "which companies are visiting the site", and a school
 *  district reads as a company here more comfortably than as a corporation. */
export const FILTER_LABEL: Record<OrgFilter, string> = {
  matched: 'Known to you',
  corporate: 'Companies',
  isp: 'Consumer ISPs',
  hosting: 'Hosting & bots',
  all: 'All',
};

export const KIND_BADGE: Record<OrgKind, string> = {
  corporate: 'Company',
  isp: 'ISP',
  hosting: 'Hosting',
};

export interface KindCounts {
  corporate: number;
  isp: number;
  hosting: number;
  /** Organizations matching a lead or a tracked manufacturer. NOT part of the
   *  partition — a matched row is also one of the three kinds, so this is the
   *  one count that overlaps and must never be added into a total. */
  matched: number;
}

/** The wording on a matched row's badge, by where we already know them from.
 *  Open-ended by design: a LinkedIn-connections import adds a case here and
 *  nothing else (the server's `match.kind` is a plain string for that reason). */
export function matchBadge(kind: string): string {
  if (kind === 'lead') return 'In your leads';
  if (kind === 'manufacturer') return 'Tracked manufacturer';
  if (kind === 'linkedin') return 'LinkedIn connection';
  return 'Known to you';
}

/** Chip counts, `all` derived rather than sent: the server's three counts
 *  partition the list it returned, so their sum IS the row count and a
 *  separate total could only ever disagree with it. */
export function filterCount(counts: KindCounts, filter: OrgFilter): number {
  if (filter === 'all') return counts.corporate + counts.isp + counts.hosting;
  return counts[filter];
}

/** Matched rows first, each group otherwise keeping the server's order (which
 *  is visitors desc). A stable partition, not a re-sort: the server already
 *  decided what "busiest" means and this must not quietly disagree with it. */
export function matchedFirst(organizations: VisitorOrganization[]): VisitorOrganization[] {
  return [
    ...organizations.filter((org) => org.match != null),
    ...organizations.filter((org) => org.match == null),
  ];
}

export function filterOrganizations(
  organizations: VisitorOrganization[],
  filter: OrgFilter,
): VisitorOrganization[] {
  // Ordering (including matched-first) belongs to sortOrganizations — this
  // only decides membership, so the two cannot disagree about the top row.
  if (filter === 'all') return organizations;
  if (filter === 'matched') return organizations.filter((org) => org.match != null);
  return organizations.filter((org) => org.kind === filter);
}

/**
 * One place, as specifically as the row knows it.
 *
 * Every field is nullable and the combinations are all real: city+region+
 * country from the city database, country alone from a country-lite lookup or
 * pre-048 history, and city without a region from a free-tier record. The
 * country CODE is expanded to a name only when it is standing alone — "Austin,
 * Texas, United States" is noise, "United States" is the answer.
 */
export function locationLabel(location: OrgLocation): string | null {
  const parts = [location.city, location.region].filter((p): p is string => !!p);
  if (parts.length > 0) return parts.join(', ');
  return location.country ? countryName(location.country) : null;
}

/** The collapsed row's one-line place: the busiest location, plus a count of
 *  the others so a multi-site company does not look like a single office. */
export function locationSummary(locations: OrgLocation[]): string | null {
  const labels = locations.map(locationLabel).filter((l): l is string => !!l);
  if (labels.length === 0) return null;
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1} more`;
}

/** Visitors first — it is the sort key, and it is the number that answers
 *  "how many PEOPLE from this company", which views does not. */
export function visitorLine(org: { visitors: number; views: number }): string {
  return `${plural(org.visitors, 'visitor')} · ${plural(org.views, 'view')}`;
}

/**
 * The panel's empty state, in words that are true for the reason it is empty.
 *
 * Three different silences, and only one of them means "nobody came":
 * capture that has not started, a window with no rows at all, and a window
 * whose rows are all in the other two buckets. Saying "no visitors" for the
 * third would be a lie about a busy week.
 */
export function emptyMessage(
  filter: OrgFilter,
  counts: KindCounts,
  trackedSince: string | null,
): string {
  if (!trackedSince) {
    return 'No organizations resolved yet. Network capture began 2026-08-30 — rows appear as new visits arrive.';
  }
  const total = filterCount(counts, 'all');
  if (total === 0) {
    return 'No organizations resolved in this window. Widen the range, or check the traffic segment above.';
  }
  if (filter === 'matched') {
    return `None of your leads or tracked manufacturers visited in this window — ${plural(total, 'other organization')} did.`;
  }
  return `No ${FILTER_LABEL[filter].toLowerCase()} in this window — ${plural(total, 'organization')} of another kind did visit.`;
}

/**
 * How the list is ordered. The server sorts by DISTINCT VISITORS, which
 * answers "who is most interested" — but that is one question of three, and
 * the other two are the ones a person reaches for when scanning a long list
 * (owner, 2026-08-31): when did they last come, and where is the name I am
 * looking for.
 */
export type OrgSort = 'visitors' | 'recent' | 'name';

export const ORG_SORTS: Array<{ key: OrgSort; label: string }> = [
  { key: 'visitors', label: 'Most visitors' },
  { key: 'recent', label: 'Most recent' },
  { key: 'name', label: 'A–Z' },
];

/** Epoch millis for a row's last visit; -Infinity when it has none, so rows
 *  with no timestamp sink rather than sorting as 1970. */
function lastSeenAt(org: VisitorOrganization): number {
  if (!org.last_seen) return -Infinity;
  // Same normalization cityIntel does: the API sends Python's `str(datetime)`
  // (space separator, six fractional digits), which Safari parses as NaN.
  const iso = org.last_seen.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Sort a filtered list, keeping matched rows on top.
 *
 * Matched-first survives every sort on purpose: an organization already on the
 * call list is the row the panel exists to surface, and burying it under an
 * alphabet would defeat the feature. Within each group the chosen key applies,
 * and NAME is always the final tiebreaker so the order is total — two rows
 * with the same count or the same timestamp must not swap between renders.
 */
export function sortOrganizations(
  organizations: VisitorOrganization[],
  sort: OrgSort,
): VisitorOrganization[] {
  const byName = (a: VisitorOrganization, b: VisitorOrganization) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const compare = (a: VisitorOrganization, b: VisitorOrganization): number => {
    const matched = Number(b.match != null) - Number(a.match != null);
    if (matched !== 0) return matched;
    if (sort === 'name') return byName(a, b);
    if (sort === 'recent') {
      const gap = lastSeenAt(b) - lastSeenAt(a);
      if (gap !== 0) return gap;
      return byName(a, b);
    }
    if (b.visitors !== a.visitors) return b.visitors - a.visitors;
    if (b.views !== a.views) return b.views - a.views;
    return byName(a, b);
  };

  return [...organizations].sort(compare);
}
