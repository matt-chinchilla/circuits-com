// Phone-number display formatter shared across scopes.
//
// The supplier table stores phones in many shapes (`631-555-5555`,
// `(631) 555-5555`, raw `16314950445`, international `+44-1945-474747`).
// formatPhone() normalizes them to one consistent display form so surfaces
// like the Preferred Partners banner don't show three different syntaxes
// side by side. Pair with a one-time DB normalization for stored values;
// this guarantees consistent rendering even if a raw value slips in later.

/**
 * Normalize a phone number for display.
 *
 * - Empty/nullish → "".
 * - International (leading `+`): keep the `+`, collapse all separators to
 *   single spaces. Country grouping varies too much to reshape safely, so we
 *   only standardize the separators (e.g. `+44-1945-474747` → `+44 1945 474747`).
 * - US/CA (10 digits, or 11 with a leading country-code `1`): `(AAA) NNN-NNNN`.
 * - Anything else: returned trimmed, unchanged (don't mangle unknown shapes).
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('+')) {
    return `+${trimmed.slice(1).replace(/[^\d]+/g, ' ').trim()}`;
  }

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return trimmed;
}
