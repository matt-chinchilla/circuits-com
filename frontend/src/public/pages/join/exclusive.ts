// Pure helpers for the Gold/Platinum buy flow on /join (spec 2026-09-23 §11).
//
// Nothing here computes a price: the server's sales_pricing is the single home
// and the page renders only the numbers /api/checkout/quote returns. These are
// the formatting, parsing and message rules the page and its modal share, kept
// DOM-free so vitest can pin them.

import type { ExclusiveTier, SlotRow } from '@public/types/checkout';

export type {
  ExclusiveCheckoutResult,
  ExclusiveTier,
  QuoteResult,
  SlotRow,
  SlotsResponse,
} from '@public/types/checkout';

export const EXCLUSIVE_TIERS: readonly ExclusiveTier[] = ['gold', 'platinum'];

export const EXCLUSIVE_STASH_KEY = 'cc.exclusiveCheckout';

/** A checkout session lives 35 minutes; a day covers any real return trip. */
export const STASH_TTL_MS = 24 * 60 * 60 * 1000;

export function isExclusiveTier(v: unknown): v is ExclusiveTier {
  return v === 'gold' || v === 'platinum';
}

/** "$2,100" — whole dollars, thousands separators, never cents. */
export function money(usd: number): string {
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

// Mirrors api/app/services/sales_codes.normalize_code's forgiving read side:
// whitespace, every dash a phone or word processor pastes, and underscores are
// dropped; O reads as 0, I and L as 1. The server re-normalizes and is the only
// judge of validity — this only makes what the buyer sees match what the rep
// sent (XXXX-XXXX).
const SEPARATORS = /[\s\-\u2010-\u2014\u2212_]/g;

export function normalizeCodeInput(raw: string): string {
  const code = raw
    .replace(SEPARATORS, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export interface SlotGroup {
  key: string;
  name: string;
  rows: SlotRow[];
}

/** Gold slots are subcategories, grouped under their parent in server order;
 *  Platinum slots are the top-level categories themselves — one flat group.
 *  Held rows are KEPT: the picker shows them as "being purchased". */
export function groupSlots(rows: SlotRow[], tier: ExclusiveTier): SlotGroup[] {
  if (rows.length === 0) return [];
  if (tier === 'platinum') return [{ key: 'platinum', name: 'Top-level categories', rows }];
  const groups = new Map<string, SlotGroup>();
  for (const r of rows) {
    const name = r.parent_name ?? 'Other';
    let g = groups.get(name);
    if (!g) {
      g = { key: name, name, rows: [] };
      groups.set(name, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}

export interface JoinParams {
  code?: string;
  tier?: ExclusiveTier;
  slot?: string;
  welcome?: ExclusiveTier;
  released?: boolean;
  card?: 'updated';
}

const MAX_PARAM = 64;

/** Read once at mount; the page strips these from the URL right after. */
export function readJoinParams(search: string): JoinParams {
  const q = new URLSearchParams(search);
  const out: JoinParams = {};
  const text = (key: string): string | undefined => {
    const v = (q.get(key) ?? '').trim();
    return v && v.length <= MAX_PARAM ? v : undefined;
  };
  const code = text('code');
  if (code) out.code = code;
  const tier = text('tier')?.toLowerCase();
  if (isExclusiveTier(tier)) out.tier = tier;
  const slot = text('slot');
  if (slot) out.slot = slot;
  const welcome = text('welcome')?.toLowerCase();
  if (isExclusiveTier(welcome)) out.welcome = welcome;
  if (q.get('released') === '1') out.released = true;
  if (q.get('card') === 'updated') out.card = 'updated';
  return out;
}

/** What the confirm modal leaves behind before handing off to Stripe. */
export interface ExclusiveStash {
  tier: ExclusiveTier;
  release_token?: string;
  slot_id?: string;
  slot_name?: string;
  slot_path?: string;
  company?: string;
  email?: string;
  price_usd?: number;
  ts: number;
}

export function parseStash(raw: string | null, now: number): ExclusiveStash | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const s = parsed as Partial<ExclusiveStash>;
    if (typeof s.ts !== 'number' || now - s.ts > STASH_TTL_MS) return null;
    if (!isExclusiveTier(s.tier)) return null;
    return s as ExclusiveStash;
  } catch {
    return null;
  }
}

/** Read-once: the stash is removed as it is read, so a shared return URL can
 *  never replay someone else's name or release someone else's hold. */
export function takeStash(storage: Storage | null = safeSession()): ExclusiveStash | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(EXCLUSIVE_STASH_KEY);
    storage.removeItem(EXCLUSIVE_STASH_KEY);
    return parseStash(raw, Date.now());
  } catch {
    return null;
  }
}

export function writeStash(value: ExclusiveStash, storage: Storage | null = safeSession()): void {
  try {
    storage?.setItem(EXCLUSIVE_STASH_KEY, JSON.stringify(value));
  } catch {
    /* private mode — the stash is a nicety; the hold still lapses on its own */
  }
}

export function clearStash(storage: Storage | null = safeSession()): void {
  try {
    storage?.removeItem(EXCLUSIVE_STASH_KEY);
  } catch {
    /* nothing stale to clear either */
  }
}

function safeSession(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** "3:45 PM" in the buyer's own clock; null for anything unparseable. */
export function clockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function heldLine(iso: string | null | undefined): string {
  const t = clockTime(iso);
  return t ? `Being purchased — try again after ${t}` : 'Being purchased — try again shortly';
}

/** The buyer-facing sentence for a failed POST /api/checkout/exclusive (spec §11). */
export function checkoutErrorMessage(
  status: number | undefined,
  detail: unknown,
  heldUntil?: string | null,
): string {
  if (status === 409) {
    if (detail === 'slot_held') {
      const t = clockTime(heldUntil);
      return t
        ? `Being purchased — held until ${t}. Pick another slot or try again then.`
        : 'Being purchased by someone else right now — pick another slot or try again shortly.';
    }
    if (detail === 'already_sponsor') {
      return 'This company already sponsors this category — ask your rep.';
    }
    return 'This slot was just taken — pick another, or ask the desk what opens next.';
  }
  if (status === 429) {
    if (detail === 'hold_limit') {
      return 'You already have a checkout open. Finish it, or wait for it to lapse, before starting another.';
    }
    return 'Too many attempts — wait a few minutes and try again.';
  }
  if (status === 422) {
    if (typeof detail === 'string' && detail && !/^stripe:/i.test(detail)) return detail;
    if (Array.isArray(detail)) return 'Check the company name and email, then try again.';
  }
  if (status === 404) {
    return 'Self-serve checkout is switched off right now — the partners desk can place you directly.';
  }
  return 'Could not start checkout — try again, or ask the partners desk.';
}
