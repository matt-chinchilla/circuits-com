// GENERATED FILE — do not edit by hand.
// Regenerate with:  node scripts/gen-header-aliases.mjs   (run from frontend/)
// Source of truth:  docs/design-briefs/bom-header-aliases-raw.json
//                   docs/design-briefs/bom-kicad-research-2026-08-19.md
//
// The sweep's 14 refuted claims are NOT in the map: they were verifier-shown to
// be runtime-constructed strings (a distributor name + '#', and the
// LCSC/JLCPCB x Part-variant cross-product), so they live as the two pattern
// rules at the foot of this file instead of as fake literals.

export type BomRole =
  | 'mpn'
  | 'manufacturer'
  | 'refs'
  | 'qty'
  | 'value'
  | 'footprint'
  | 'description'
  | 'datasheet'
  | 'dnp'
  | 'distributor_pn';

export const HEADER_ALIASES: Record<string, BomRole> = {
  "#": "distributor_pn",
  "arrow": "distributor_pn",
  "build quantity": "qty",
  "cat#": "distributor_pn",
  "cmp name": "value",
  "comment": "value",
  "config": "dnp",
  "customer no": "refs",
  "datasheet": "datasheet",
  "desc": "description",
  "description": "description",
  "designator": "refs",
  "digikey": "distributor_pn",
  "dnp": "dnp",
  "exclude_from_bom": "dnp",
  "farnell": "distributor_pn",
  "fit_field": "dnp",
  "fit_field = config": "dnp",
  "footprint": "footprint",
  "footprint full": "footprint",
  "footprint lib": "footprint",
  "jlc": "distributor_pn",
  "jlc_pn": "distributor_pn",
  "kicad_dnp": "dnp",
  "lcsc": "distributor_pn",
  "lcsc part #(optional)": "distributor_pn",
  "lcsc#": "distributor_pn",
  "lcsc_pn": "distributor_pn",
  "man": "manufacturer",
  "man#": "mpn",
  "man-num": "mpn",
  "man_num": "mpn",
  "manf": "manufacturer",
  "manf#": "mpn",
  "manf#_qty": "qty",
  "manf-num": "mpn",
  "manf_num": "mpn",
  "manpartno": "mpn",
  "manufacturer": "manufacturer",
  "manufacturer name": "manufacturer",
  "manufacturer part number": "mpn",
  "mfg": "manufacturer",
  "mfg part#": "mpn",
  "mfg#": "mpn",
  "mfg-num": "mpn",
  "mfg_num": "mpn",
  "mfr": "manufacturer",
  "mfr#": "mpn",
  "mfr-num": "mpn",
  "mfr. no": "mpn",
  "mfr.part": "mpn",
  "mfr_num": "mpn",
  "mnf": "manufacturer",
  "mnf#": "mpn",
  "mnf-num": "mpn",
  "mnf_num": "mpn",
  "mouser": "distributor_pn",
  "mpn": "mpn",
  "newark": "distributor_pn",
  "nopop": "dnp",
  "num": "distributor_pn",
  "order qty": "qty",
  "p#": "mpn",
  "package": "footprint",
  "part": "refs",
  "part reference": "refs",
  "part value": "value",
  "part#": "mpn",
  "part-num": "mpn",
  "part_num": "mpn",
  "parts": "refs",
  "pcb footprint": "footprint",
  "pcb package": "footprint",
  "pdf": "datasheet",
  "pn": "mpn",
  "qnty": "qty",
  "qty": "qty",
  "quantity": "qty",
  "quantity per pcb": "qty",
  "ref": "refs",
  "reference": "refs",
  "reference designator": "refs",
  "reference(s)": "refs",
  "references": "refs",
  "refs": "refs",
  "rs": "distributor_pn",
  "stock code": "mpn",
  "tme": "distributor_pn",
  "val": "value",
  "value": "value",
  "vendor#": "distributor_pn",
  "vp#": "distributor_pn",
  "vpn": "distributor_pn",
};

/**
 * Fold a raw header cell to its lookup key: unwrap a `${...}` field
 * reference, strip surrounding quote/space punctuation, lowercase, collapse
 * inner whitespace. Must stay byte-identical to `normalize` in
 * scripts/gen-header-aliases.mjs — every generated key is pre-normalized and a
 * test asserts `key === normalizeHeader(key)`.
 */
export function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\s*\${(.+)}\s*$/, '$1')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// A distributor name followed by '#' — KiCost/KiBot build these at runtime
// (`dist + '#'`) over the whole distributor registry, so no literal list can
// be complete.
const DISTRIBUTOR_HASH = /^[a-z][a-z0-9 ]*#$/;
// Fabrication-Toolkit's cross-product of ['LCSC','JLCPCB'] with
// ['Part #','Part','PN','P/N','Part No.','Part Number'].
const LCSC_JLCPCB = /^(lcsc|jlcpcb) ?(part ?(#|no\.?|number)?|pn|p\/n)$/;

export function matchHeader(raw: string): BomRole | null {
  const key = normalizeHeader(raw);
  if (!key) return null;
  const direct = HEADER_ALIASES[key];
  if (direct) return direct;
  if (LCSC_JLCPCB.test(key)) return 'distributor_pn';
  if (DISTRIBUTOR_HASH.test(key) && key !== '#') return 'distributor_pn';
  return null;
}
