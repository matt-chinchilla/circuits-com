import type { BomRole } from './headerAliases';

/**
 * Remembered column maps, keyed by header signature.
 *
 * The point is narrow: a person who exports the same BOM template every week
 * should answer the mapper's question ONCE. The key is the parser's
 * `headerSignature` (normalized headers joined), so two exports from the same
 * tool collide on purpose and a different template never does.
 *
 * Storage is best-effort by design. Every read and write sits inside a
 * try/catch that degrades to "no memory" — Safari private mode throws on
 * `localStorage` access itself, and a mapper that crashes the page is worse
 * than a mapper the user answers twice. Stored content is treated as hostile
 * input for the same reason: it survives deploys, so an old or hand-edited
 * shape must validate to null, never reach the table as a role.
 */

export const MAP_MEMORY_KEY = 'cc.bom.columnMaps';

/** Twenty templates is far past any one person's set of exporters; the cap
 *  exists so a shared machine cannot grow this entry without bound. */
export const MAX_REMEMBERED_SIGNATURES = 20;

/** The persisted allowlist — a value outside it is dropped on read. Mirrors
 *  the `BomRole` union in headerAliases.ts (the union is a type and cannot be
 *  enumerated at runtime; this array is that union's runtime half). */
export const BOM_ROLES: readonly BomRole[] = [
  'mpn',
  'manufacturer',
  'refs',
  'qty',
  'value',
  'footprint',
  'description',
  'datasheet',
  'dnp',
  'distributor_pn',
];

const ROLE_SET = new Set<string>(BOM_ROLES);

interface StoredEntry {
  roles: (BomRole | null)[];
  savedAt: number;
}

type Store = Record<string, StoredEntry>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(MAP_MEMORY_KEY);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    // Corrupt JSON, or storage denied outright — both mean "no memory".
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(MAP_MEMORY_KEY, JSON.stringify(store));
  } catch {
    // Quota or private mode: the mapping is still applied for this visit, it
    // just will not be remembered for the next one.
  }
}

/** Sanitize one stored entry. An unrecognized role becomes "ignore this
 *  column" rather than invalidating the whole map — the user still gets the
 *  columns they mapped last time. */
function rolesOf(entry: unknown): (BomRole | null)[] | null {
  if (entry == null || typeof entry !== 'object') return null;
  const roles = (entry as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return null;
  return roles.map((role) =>
    typeof role === 'string' && ROLE_SET.has(role) ? (role as BomRole) : null,
  );
}

export function loadRoleMap(signature: string): (BomRole | null)[] | null {
  if (signature === '') return null;
  const store = readStore();
  if (!Object.prototype.hasOwnProperty.call(store, signature)) return null;
  return rolesOf(store[signature]);
}

export function saveRoleMap(signature: string, roles: (BomRole | null)[]): void {
  if (signature === '') return;
  const store = readStore();

  // Delete before re-inserting so key order tracks recency: JSON objects keep
  // insertion order, and that order is the tiebreak when two entries share a
  // millisecond timestamp.
  delete store[signature];
  store[signature] = { roles, savedAt: Date.now() };

  const keys = Object.keys(store);
  if (keys.length > MAX_REMEMBERED_SIGNATURES) {
    const byAge = keys.slice().sort((a, b) => {
      const aAt = typeof store[a]?.savedAt === 'number' ? store[a].savedAt : 0;
      const bAt = typeof store[b]?.savedAt === 'number' ? store[b].savedAt : 0;
      return aAt - bAt;
    });
    for (const stale of byAge.slice(0, keys.length - MAX_REMEMBERED_SIGNATURES)) {
      delete store[stale];
    }
  }

  writeStore(store);
}
