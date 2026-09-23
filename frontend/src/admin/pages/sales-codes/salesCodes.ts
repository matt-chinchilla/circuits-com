// Pure helpers for the Sales codes page and its Needs-attention strip. The
// server (routes/admin_sales_codes.py) derives every status and builds every
// link; this file only words them. No price is computed here.

import { cancelsOn } from '@admin/pages/sponsors/form/billingFormat';
import { dualPriceRows, priceRows, type PriceRowModel } from '@admin/components/ListSelect/priceRows';
import type {
  AttentionPayload,
  QuoteLadderTier,
  SalesCode,
  SalesCodeCreate,
  SalesTier,
} from '@admin/types/admin';

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
  return `${points}% off list`;
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

// ── New-code form ───────────────────────────────────────────────────────────

export const MAX_CODE_POINTS = 15;
export const MAX_USES_CAP = 100;
/** The server's own 422 sentence for R7 — kept word for word. */
export const BOUND_NEEDS_EMAIL = "A code tied to a company needs the customer's email.";

export interface CodeFormState {
  points: number;
  tier: 'any' | SalesTier;
  categoryId: string;
  supplierId: string;
  emailLock: string;
  maxUses: string;
  expiresInDays: number;
  rep: string;
  note: string;
}

export type CodeFormErrors = Partial<Record<'emailLock' | 'maxUses' | 'categoryId' | 'points', string>>;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function codeFormErrors(f: CodeFormState): CodeFormErrors {
  const errors: CodeFormErrors = {};
  if (!Number.isInteger(f.points) || f.points < 1 || f.points > MAX_CODE_POINTS) {
    errors.points = `Between 1% and ${MAX_CODE_POINTS}%.`;
  }
  const email = f.emailLock.trim();
  if (f.supplierId && !email) errors.emailLock = BOUND_NEEDS_EMAIL;
  else if (email && !EMAIL_SHAPE.test(email)) errors.emailLock = 'That does not look like an email address.';
  const uses = f.maxUses.trim();
  if (!/^\d+$/.test(uses) || Number(uses) < 1 || Number(uses) > MAX_USES_CAP) {
    errors.maxUses = `Between 1 and ${MAX_USES_CAP} uses.`;
  }
  if (f.categoryId && f.tier === 'any') errors.categoryId = 'Pick Gold or Platinum to lock a placement.';
  return errors;
}

/** The POST body — only the locks that are set, every string trimmed. */
export function codeCreateBody(f: CodeFormState): SalesCodeCreate {
  const body: SalesCodeCreate = { code_points: f.points };
  if (f.tier !== 'any') body.tier = f.tier;
  if (f.categoryId) body.category_id = f.categoryId;
  if (f.supplierId) body.supplier_id = f.supplierId;
  if (f.emailLock.trim()) body.email_lock = f.emailLock.trim();
  body.max_uses = Number(f.maxUses.trim());
  body.expires_in_days = f.expiresInDays;
  if (f.rep.trim()) body.rep = f.rep.trim();
  if (f.note.trim()) body.note = f.note.trim();
  return body;
}

/** The discount rows for a new code, priced by the SERVER's ladder: one price
 *  for a tier-locked code, Gold and Platinum side by side for either tier.
 *  A code is always 1–15% — the 0% row (the Founder's Deal alone) is left out. */
export function codePriceRows(
  tiers: Record<string, QuoteLadderTier> | null | undefined,
  tier: 'any' | SalesTier,
  points: number[],
): PriceRowModel[] {
  if (tier !== 'any') {
    const ladder = tiers?.[tier];
    return ladder
      ? priceRows(ladder, { includeFounder: false }).filter((r) => points.includes(r.value))
      : dualPriceRows({}, points);
  }
  return dualPriceRows({ gold: tiers?.gold, platinum: tiers?.platinum }, points);
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
