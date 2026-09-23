// Pure helpers for the Sales codes page and its Needs-attention strip. The
// server (routes/admin_sales_codes.py) derives every status and builds every
// link; this file only words them. No price is computed here.

import { cancelsOn } from '@admin/pages/sponsors/form/billingFormat';
import type { AttentionPayload, SalesCode } from '@admin/types/admin';

export type ChipTone = 'ok' | 'info' | 'warn' | 'muted';

const STATUS_META: Record<string, { label: string; tone: ChipTone }> = {
  live: { label: 'Live', tone: 'ok' },
  used_up: { label: 'Used up', tone: 'info' },
  expired: { label: 'Expired', tone: 'muted' },
  off: { label: 'Switched off', tone: 'muted' },
};

function humanize(value: string): string {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** The status chip for a code's server-derived status. */
export function codeStatusChip(status: string): { label: string; tone: ChipTone } {
  return STATUS_META[status] ?? { label: humanize(status) || 'Unknown', tone: 'muted' };
}

/** The server hands back a PATH (`/join?code=…`); a rep shares a full URL. */
export function absoluteLink(link: string, origin: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const base = origin.replace(/\/+$/, '');
  return `${base}/${link.replace(/^\/+/, '')}`;
}

export function usesLabel(code: Pick<SalesCode, 'uses' | 'max_uses'>): string {
  return `${code.uses} of ${code.max_uses} used`;
}

export function pointsLabel(points: number): string {
  return `${points} ${points === 1 ? 'pt' : 'pts'} off list`;
}

/** The code's locks, most general first. Nothing locked = works on any slot. */
export function locksSummary(
  code: Pick<SalesCode, 'tier' | 'category_name' | 'supplier_name' | 'email_lock'>,
): string[] {
  const parts: string[] = [];
  if (code.tier) parts.push(humanize(code.tier));
  if (code.category_name) parts.push(code.category_name);
  if (code.supplier_name) parts.push(code.supplier_name);
  if (code.email_lock) parts.push(code.email_lock);
  return parts.length ? parts : ['Any Gold or Platinum slot'];
}

function shortDay(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

export function expiresLabel(expiresAt: string, now: Date = new Date()): string {
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getTime() > now.getTime() ? 'Expires' : 'Expired'} ${shortDay(d)}`;
}

// ── Needs attention ─────────────────────────────────────────────────────────
// The attention route is built in parallel (Track B), so its row shapes are
// read TOLERANTLY: each field tries the names the intent / billing tables use
// and the obvious serializer spellings. A row with no id is dropped — the
// strip only lists what a rep can act on.

/** checkout_intents.conflict_reason → what happened, for a rep. */
export const CONFLICT_REASONS: Record<string, string> = {
  slot_taken: 'Someone else took the slot first',
  amount_mismatch: 'The amount paid did not match the price',
  matrix: 'That tier cannot be placed on that category',
  category_missing: 'The category was deleted before payment landed',
  already_sponsor: 'The company already sponsors that category',
  bad_metadata: 'The checkout arrived without its order details',
};

export interface ConflictRow {
  id: string;
  company: string;
  tier: string;
  place: string;
  reason: string;
  priceUsd: number | null;
  at: string | null;
}

export interface HoldRow {
  id: string;
  company: string;
  tier: string;
  place: string;
  email: string | null;
  until: string | null;
}

export interface FailingRow {
  sponsorId: string;
  company: string;
  tier: string;
  place: string;
  failingSince: string | null;
  cancelsOn: string | null;
  priceUsd: number | null;
}

export interface Attention {
  conflicts: ConflictRow[];
  holds: HoldRow[];
  failing: FailingRow[];
  total: number;
}

type Row = Record<string, unknown>;

function str(row: Row, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function num(row: Row, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function rows(list: unknown): Row[] {
  return Array.isArray(list)
    ? list.filter((r): r is Row => typeof r === 'object' && r !== null && !Array.isArray(r))
    : [];
}

const COMPANY = ['company_name', 'company', 'supplier_name', 'name'];
const PLACE = ['category_name', 'category', 'placement', 'path'];

export function normalizeAttention(raw: AttentionPayload | null | undefined): Attention {
  const conflicts: ConflictRow[] = [];
  for (const r of rows(raw?.conflicts)) {
    const id = str(r, 'id', 'intent_id');
    if (!id) continue;
    const reason = str(r, 'conflict_reason', 'reason') ?? '';
    conflicts.push({
      id,
      company: str(r, ...COMPANY) ?? 'Unknown buyer',
      tier: humanize(str(r, 'tier') ?? ''),
      place: str(r, ...PLACE) ?? '',
      reason: CONFLICT_REASONS[reason] ?? (humanize(reason) || 'Needs a refund'),
      priceUsd: num(r, 'price_usd'),
      at: str(r, 'created_at', 'at'),
    });
  }
  const holds: HoldRow[] = [];
  for (const r of rows(raw?.holds)) {
    const id = str(r, 'id', 'intent_id');
    if (!id) continue;
    holds.push({
      id,
      company: str(r, ...COMPANY) ?? 'Unknown buyer',
      tier: humanize(str(r, 'tier') ?? ''),
      place: str(r, ...PLACE) ?? '',
      email: str(r, 'email'),
      until: str(r, 'expires_at', 'held_until'),
    });
  }
  const failing: FailingRow[] = [];
  for (const r of rows(raw?.failing)) {
    const sponsorId = str(r, 'sponsor_id', 'id');
    if (!sponsorId) continue;
    const failingSince = str(r, 'failing_since');
    failing.push({
      sponsorId,
      company: str(r, 'company', 'supplier_name', 'company_name', 'name') ?? 'Unknown sponsor',
      tier: humanize(str(r, 'tier') ?? ''),
      place: str(r, ...PLACE) ?? '',
      failingSince,
      cancelsOn: str(r, 'cancels_on') ?? cancelsOn(failingSince),
      priceUsd: num(r, 'price_usd'),
    });
  }
  return { conflicts, holds, failing, total: conflicts.length + holds.length + failing.length };
}
