// The ONE relative-time home for the Leads CRM (review finding: one PR shipped
// four copies of the offset-less-timestamp guard and three formatters, already
// divergent — "4w ago" vs "1mo ago" for the same value).
//
// The zone guard: the API emits `datetime.isoformat()` of timezone-aware UTC
// values, but older rows/serializers can drop the offset. An offset-less ISO
// string is DEFINED here as UTC — never local — or every timestamp shifts by
// the viewer's timezone.

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Epoch millis for a server ISO timestamp; NaN when unparseable. */
export function parseServerTime(iso: string): number {
  return Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
}

/**
 * Coarse relative age — a call list cares about "this week" vs "in March".
 * Floor semantics; "just now" under a minute; weeks up to 5, then months.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = parseServerTime(iso);
  if (!Number.isFinite(then)) return null;
  const diffMs = Math.max(0, now - then);
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
