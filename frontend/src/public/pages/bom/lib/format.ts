// Money, spelled the same way everywhere on the BOM page.
//
// Two components print prices — the table row and the alternates popover —
// and they print the SAME offer. A sub-dollar unit price that renders
// "$0.0042" in the row and "$0.00" in the popover would read as two different
// prices for one listing, so the rule lives in one place rather than being
// re-typed per component.

/** Unit price: four decimals under a dollar (passives are cents-fractions),
 *  two above. */
export function formatUnit(price: number): string {
  return price < 1 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`;
}

/** An extended or total figure — always two decimals, thousands grouped. */
export function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
