// Regenerates src/public/pages/bom/lib/headerAliases.ts from the
// citation-verified raw claims (301 upheld, 14 refuted -> pattern rules).
//
// Run from frontend/:  node scripts/gen-header-aliases.mjs
// The OUTPUT IS COMMITTED — the Docker build stage has no access to docs/.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, '../../docs/design-briefs/bom-header-aliases-raw.json');
const OUT = join(here, '../src/public/pages/bom/lib/headerAliases.ts');

const ROLES = ['mpn', 'manufacturer', 'refs', 'qty', 'value', 'footprint',
  'description', 'datasheet', 'dnp', 'distributor_pn'];

// PINS — every entry here is a HUMAN decision. A pinned key is authoritative:
// the sweep never overwrites it and never re-litigates it as a conflict.
//
// The legacy-exporter spellings live in the kicad-research brief, not the
// alias sweep (its verifier recorded "no occurrence in the KiCost tree" —
// they come from KiCad's own bundled scripts). Attested at
// docs/design-briefs/bom-kicad-research-2026-08-19.md:39-42.
//
// pn / p# / part# are the three role COLLISIONS in the sweep (mpn vs
// distributor_pn) and are pinned to mpn on the evidence: KiCost/KiBot map the
// BARE spellings to the manufacturer part number
// (kicost/edas/eda.py:42,63,64 and kibot/fil_base.py:29,47,48 — `'pn': 'manf#'`),
// while the distributor sense only ever appears as a per-distributor STUB
// (kibot/misc.py:163 DISTRIBUTORS_STUBS, kicost/edas/eda.py:92) that is
// prefixed with a distributor name before it can match — which is exactly what
// the DISTRIBUTOR_HASH pattern rule below covers.
const EXTRA = {
  qnty: 'qty',
  'cmp name': 'value',
  'reference(s)': 'refs',
  ref: 'refs',
  '#': 'distributor_pn',
  pn: 'mpn',
  'p#': 'mpn',
  'part#': 'mpn',
};

const normalize = (raw) => raw
  .replace(/^\s*\$\{(.+)\}\s*$/, '$1')
  .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const { byRole, verdict } = JSON.parse(readFileSync(RAW, 'utf8'));
const refuted = new Set(verdict.refuted.map((s) => normalize(s.split('/').slice(1).join('/'))));
const map = { ...EXTRA };
const conflicts = [];
const skippedProse = [];
// Two sweep entries are the researcher's PROSE DESCRIPTION of a runtime
// pattern ("lcsc|jlc (case-insensitive re.match prefix pattern over ...)"),
// not a header anyone ever typed. No real column header is 40 characters of
// prose (the longest attested literal is "manufacturer part number", 24), so
// the length cap drops them — loudly, never silently.
const MAX_HEADER_LEN = 40;
for (const role of ROLES) {
  for (const alias of Object.keys(byRole[role] ?? {})) {
    const key = normalize(alias);
    if (!key || refuted.has(key)) continue;
    if (key.length > MAX_HEADER_LEN) { skippedProse.push(`${role}: ${key}`); continue; }
    if (key in EXTRA) continue; // human pin wins, silently and permanently
    if (map[key] && map[key] !== role) conflicts.push(`${key}: ${map[key]} vs ${role}`);
    map[key] = role;
  }
}
if (conflicts.length) {
  // A collision must be resolved by a HUMAN pin in EXTRA, loudly — never by
  // whichever role happened to iterate last.
  throw new Error(`alias role conflicts:\n${conflicts.join('\n')}`);
}
const entries = Object.keys(map).sort()
  .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])},`).join('\n');

const HEADER_TEMPLATE = (rows) => `// GENERATED FILE — do not edit by hand.
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
${rows}
};

/**
 * Fold a raw header cell to its lookup key: unwrap a \`\${...}\` field
 * reference, strip surrounding quote/space punctuation, lowercase, collapse
 * inner whitespace. Must stay byte-identical to \`normalize\` in
 * scripts/gen-header-aliases.mjs — every generated key is pre-normalized and a
 * test asserts \`key === normalizeHeader(key)\`.
 */
export function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\\s*\\\${(.+)}\\s*$/, '$1')
    .replace(/^[\\s"'\`]+|[\\s"'\`]+$/g, '')
    .toLowerCase()
    .replace(/\\s+/g, ' ')
    .trim();
}

// A distributor name followed by '#' — KiCost/KiBot build these at runtime
// (\`dist + '#'\`) over the whole distributor registry, so no literal list can
// be complete.
const DISTRIBUTOR_HASH = /^[a-z][a-z0-9 ]*#$/;
// Fabrication-Toolkit's cross-product of ['LCSC','JLCPCB'] with
// ['Part #','Part','PN','P/N','Part No.','Part Number'].
const LCSC_JLCPCB = /^(lcsc|jlcpcb) ?(part ?(#|no\\.?|number)?|pn|p\\/n)$/;

export function matchHeader(raw: string): BomRole | null {
  const key = normalizeHeader(raw);
  if (!key) return null;
  const direct = HEADER_ALIASES[key];
  if (direct) return direct;
  if (LCSC_JLCPCB.test(key)) return 'distributor_pn';
  if (DISTRIBUTOR_HASH.test(key) && key !== '#') return 'distributor_pn';
  return null;
}
`;

writeFileSync(OUT, HEADER_TEMPLATE(entries));
for (const p of skippedProse) console.log(`skipped (prose, not a header): ${p}`);
console.log(`headerAliases.ts: ${Object.keys(map).length} aliases`);
