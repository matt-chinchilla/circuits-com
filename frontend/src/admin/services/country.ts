// ISO-3166 alpha-2 → what a person reads. The single home for both halves.
//
// Two admin surfaces render country codes now — the Reports world map and the
// Users roster's Location column — and both had the same two three-line
// helpers in front of them. Hoisted before they sprouted a third copy.
//
// Pure and browser-free apart from Intl, so it unit-tests with no React.

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

/** "US" → "United States". Falls back to the raw code on anything Intl
 *  refuses, so an unknown code still renders as itself rather than blank. */
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji ("US" → 🇺🇸). */
export function flagEmoji(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '';
  const up = iso.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + (up.charCodeAt(0) - 65),
    0x1f1e6 + (up.charCodeAt(1) - 65),
  );
}
