// Cross-page formatting helpers for the public part tables (category
// PartsTable + search SrPartsTable). Pure functions, no React.

/**
 * Tiered price precision: whole dollars at ≥$100, cents at ≥$1, tenth-cents
 * under $1. Unknown → em dash.
 */
export function formatPrice(price: number | null | undefined): string {
  if (price == null) return '—';
  if (price >= 100) return `$${price.toFixed(0)}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(3)}`;
}

/** RoHS cell: compliant → check mark, non-compliant → "No", unknown → em dash. */
export function formatRohs(rohs: boolean | null | undefined): string {
  if (rohs == null) return '—';
  return rohs ? '✓' : 'No';
}
