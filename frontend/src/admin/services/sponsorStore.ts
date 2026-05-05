import type { AdminSponsor } from '@admin/types/admin';

// Shared localStorage-backed store for the admin sponsors UI. Both list and
// form pages route through here so the seed sponsors materialize on the very
// first read — without it, deleting a seed sponsor (e.g. spn-honeywell-sensors)
// silently writes [] to localStorage and the entire seed list disappears.
//
// When backend admin sponsor CRUD endpoints land, swap the persistence layer
// here without touching either page (CLAUDE.md gotcha — list + form are
// already split into sibling pages exactly so this swap is local).

const STORE_KEY = 'circuits.admin.sponsors';

export const SEED_SPONSORS: AdminSponsor[] = [
  {
    id: 'spn-honeywell-sensors',
    supplier_id: 'seed-supplier-honeywell',
    supplier_name: 'Honeywell Sensing',
    tier: 'Featured',
    category_id: 'cat-sensors',
    category_name: 'Sensors & Transducers',
    keyword: null,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    amount: 7000,
    status: 'Active',
  },
  {
    id: 'spn-ti-keyword-vreg',
    supplier_id: 'seed-supplier-ti',
    supplier_name: 'Texas Instruments',
    tier: 'Gold',
    category_id: null,
    category_name: null,
    keyword: 'voltage regulator',
    start_date: '2026-03-01',
    end_date: '2026-09-30',
    amount: 1500,
    status: 'Active',
  },
  {
    id: 'spn-arrow-pmic',
    supplier_id: 'seed-supplier-arrow',
    supplier_name: 'Arrow Electronics',
    tier: 'Platinum',
    category_id: 'cat-pmic',
    category_name: 'Power Management ICs',
    keyword: null,
    start_date: '2026-02-01',
    end_date: '2027-01-31',
    amount: 4500,
    status: 'Active',
  },
  {
    id: 'spn-mouser-keyword-stm32',
    supplier_id: 'seed-supplier-mouser',
    supplier_name: 'Mouser Electronics',
    tier: 'Silver',
    category_id: null,
    category_name: null,
    keyword: 'stm32',
    start_date: '2025-11-01',
    end_date: '2026-05-01',
    amount: 800,
    status: 'Paused',
  },
];

function writeRaw(rows: AdminSponsor[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rows));
  } catch {
    /* localStorage may be unavailable or full — non-fatal for the demo */
  }
}

export function loadSponsors(): AdminSponsor[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as AdminSponsor[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    // Corrupted localStorage payload — log so dev sees it, then fall through
    // to materialization. A partial-write of a user's edits would be lost,
    // but that's the same data that already failed to JSON.parse.
    console.warn('[sponsorStore] corrupt data, re-seeding', err);
  }
  // First read: materialize the seed so subsequent operations (delete,
  // upsert) operate against actual storage. Otherwise deleting a seed
  // sponsor is a no-op against [] and the seed silently reappears.
  writeRaw(SEED_SPONSORS);
  return SEED_SPONSORS;
}

export function findSponsor(id: string): AdminSponsor | undefined {
  return loadSponsors().find((s) => s.id === id);
}

export function upsertSponsor(next: AdminSponsor): void {
  const rows = loadSponsors();
  const idx = rows.findIndex((r) => r.id === next.id);
  if (idx === -1) writeRaw([next, ...rows]);
  else writeRaw(rows.map((r, i) => (i === idx ? next : r)));
}

export function deleteSponsor(id: string): void {
  writeRaw(loadSponsors().filter((s) => s.id !== id));
}
