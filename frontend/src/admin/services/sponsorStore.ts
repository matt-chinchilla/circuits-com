import type { AdminSponsor } from '@admin/types/admin';
import { adminApi, type SponsorCreate } from '@admin/services/adminApi';

// API-backed store for the admin sponsors UI. The pre-migration implementation
// was localStorage-backed with a 4-row seed (and fake `cat-*` category ids that
// never matched live DB UUIDs); persistence now lives on the backend
// (`/api/admin/sponsors/...`) so admin sponsor edits reach the public site.
//
// Mirrors @admin/services/messageStore: a module-level CACHE keeps a SYNC
// snapshot for the wizard's window.__adminGetStore() bridge, while the public
// read/mutate functions are async and route through adminApi. Consumer pages
// call loadSponsors() in a useEffect on mount to pull fresh server state.

let CACHE: AdminSponsor[] = [];

/** Last-fetched sponsors, for the wizard's synchronous store snapshot. */
export function cachedSponsors(): AdminSponsor[] {
  return CACHE;
}

/** Fetch all sponsors from the API and refresh the module cache. */
export async function loadSponsors(): Promise<AdminSponsor[]> {
  const rows = await adminApi.getSponsors();
  CACHE = rows;
  return rows;
}

/**
 * Fetch a single sponsor by id. The backend has no detail endpoint in the
 * contract, so we pull the list and find — the list is small (paid placements).
 */
export async function findSponsor(id: string): Promise<AdminSponsor | undefined> {
  const rows = await loadSponsors();
  return rows.find((s) => s.id === id);
}

/**
 * Create (POST) when `next` has no id, otherwise update (PATCH) the existing
 * sponsor. The server returns the canonical row, which we splice into the cache
 * so a subsequent cachedSponsors() read is fresh.
 */
export async function upsertSponsor(next: AdminSponsor): Promise<AdminSponsor> {
  const { id, ...body } = next;
  const saved = id
    ? await adminApi.updateSponsor(id, body as Partial<SponsorCreate>)
    : await adminApi.createSponsor(body as SponsorCreate);
  const idx = CACHE.findIndex((s) => s.id === saved.id);
  CACHE = idx === -1 ? [saved, ...CACHE] : CACHE.map((s, i) => (i === idx ? saved : s));
  return saved;
}

/** Delete a sponsor (DELETE) and drop it from the cache. */
export async function deleteSponsor(id: string): Promise<void> {
  await adminApi.deleteSponsor(id);
  CACHE = CACHE.filter((s) => s.id !== id);
}
