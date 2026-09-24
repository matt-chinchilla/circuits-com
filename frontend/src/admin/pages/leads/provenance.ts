// Where a lead came from — the detail page's "Added by" line.
//
// Three states, deliberately distinct:
//   • created_by is a username  → a rep added it from the console;
//   • created_by is null        → the row came from the roster import
//                                 (seed_data/leads.csv), which records no person;
//   • created_by is ABSENT      → the payload predates the key (a persisted
//                                 query-cache entry). Unknown — say nothing,
//                                 rather than claim the roster added it.
//
// The date is the EASTERN calendar day (the business runs on ET), so a lead
// added at 9pm Pacific is not stamped with tomorrow's date.

import { parseServerTime } from './time';

export function formatEasternDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = parseServerTime(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function provenanceLine(
  createdBy: string | null | undefined,
  createdAt: string | null | undefined,
  viewer?: string | null,
): string | null {
  if (createdBy === undefined) return null;
  if (createdBy === null || !createdBy.trim()) return 'From the roster import';
  const who = viewer && viewer === createdBy ? 'you' : createdBy;
  const day = formatEasternDate(createdAt);
  return day ? `Added by ${who} · ${day}` : `Added by ${who}`;
}
