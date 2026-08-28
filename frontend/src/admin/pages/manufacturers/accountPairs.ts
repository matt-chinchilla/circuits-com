// The customer console's two ROUTE PAIRS, as CatalogSwitch halves.
//
// Capability is the two links an account holds, never a type (surface-map §1):
// `supplier_id` set makes it a distributor, `manufacturer_id` set makes it a
// manufacturer, BOTH set is the normal case for the largest players, and
// NEITHER is the free browsing account. So each half is offered on its own
// flag and nothing here is an `elif`.
//
// Every route below keeps exactly ONE meaning, which is why the pairs exist at
// all — the owner's original sketch had /suppliers mean "my own page" for a
// distributor and "everyone who sells my products" for a manufacturer, which
// is undecidable for an account holding both:
//
//   Pair A  /suppliers         distributors selling MY products  needs manufacturer
//           /my-supply         my own distributor page           needs supplier
//   Pair B  /manufacturers     makers whose products I SELL      needs supplier
//           /my-manufacturing  my own maker page                 needs manufacturer
//
// A pure module rather than four inline ternaries: the same pair is built by
// the list page and by the my-* page it switches to, and two spellings of one
// rule is how a half ends up offered on one screen and hidden on the other.
//
// `consolePath` is passed IN (the caller's `useConsolePath()`) so each canonical
// /admin path is translated onto the rendering mount exactly once, right where
// it is written — the console renders at two mounts and an absolute /admin URL
// handed to a customer bounces straight back.

import type { CatalogSwitchHalf } from './CatalogSwitch';

type ConsolePath = (adminPath: string) => string;

/** `[Suppliers | My Supply]` — the halves this account has a link for. */
export function supplyPair(
  consolePath: ConsolePath,
  isSupplier: boolean,
  isManufacturer: boolean,
): CatalogSwitchHalf[] {
  const halves: CatalogSwitchHalf[] = [];
  if (isManufacturer) halves.push({ to: consolePath('/admin/suppliers'), label: 'Suppliers' });
  if (isSupplier) halves.push({ to: consolePath('/admin/my-supply'), label: 'My Supply' });
  return halves;
}

/** `[Manufacturers | My Manufacturing]`, the same join read the other way. */
export function manufacturingPair(
  consolePath: ConsolePath,
  isSupplier: boolean,
  isManufacturer: boolean,
): CatalogSwitchHalf[] {
  const halves: CatalogSwitchHalf[] = [];
  if (isSupplier) {
    halves.push({ to: consolePath('/admin/manufacturers'), label: 'Manufacturers' });
  }
  if (isManufacturer) {
    halves.push({ to: consolePath('/admin/my-manufacturing'), label: 'My Manufacturing' });
  }
  return halves;
}
