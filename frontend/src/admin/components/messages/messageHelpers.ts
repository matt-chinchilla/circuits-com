import type { Message } from '@admin/types/messages';

export function relTime(iso: string): string {
  const t = new Date(iso);
  // Reference the real clock at call time. A hardcoded NOW_REF demo anchor used
  // to live here; once Messages persisted server-side it froze every real
  // message at "now"/"Today" (see api/tests/test_admin_message_reltime_anchor.py).
  const ms = Date.now() - +t;
  const m = ms / 60_000;
  const h = m / 60;
  const d = h / 24;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  if (d < 2) return 'yesterday';
  if (d < 7) return `${Math.round(d)}d`;
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dayBucket(iso: string): 'Today' | 'Yesterday' | 'This week' | 'Earlier' {
  const t = new Date(iso);
  const d = (Date.now() - +t) / 86_400_000;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 7) return 'This week';
  return 'Earlier';
}

export function fullStamp(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC'
  );
}

// MSG-0042 — the printed designator for a message, single home so the chip and
// every aria-label read the same string.
export function designatorLabel(seq: number): string {
  return `MSG-${String(seq).padStart(4, '0')}`;
}

export function subjectFor(m: Message): string {
  switch (m.type) {
    case 'contact':
      return m.payload.subject;
    case 'join':
      return `wants to list — ${m.payload.company_name}`;
    case 'keyword':
      return m.payload.keyword;
    case 'reply':
      return '(reply)';
    case 'signup':
      return `${m.payload.full_name} signed up`;
    case 'welcome':
      return 'Welcome to Circuit Center';
  }
}

export function senderName(m: Message): string {
  switch (m.type) {
    case 'contact':
      return m.payload.name;
    case 'join':
      return m.payload.contact_person;
    case 'keyword':
      return m.payload.company_name;
    case 'reply':
      return '—';
    case 'signup':
      return m.payload.full_name;
    case 'welcome':
      // Written TO the customer, so the company is the sender — not the
      // person whose inbox it sits in.
      return 'Circuit Center';
  }
}

export function senderEmail(m: Message): string {
  if (m.type === 'reply') return m.payload.to;
  // A welcome row carries no address at all — it was sent to the customer,
  // not received from one. Reaching for `payload.email` here would print the
  // literal "undefined" into a mailto: link.
  if (m.type === 'welcome') return '—';
  return m.payload.email;
}

/**
 * Avatar initials — first letter of the first two words, upper-cased.
 * Single home so the contact and signup avatars can never disagree, and so an
 * empty/whitespace name renders a placeholder rather than an empty circle.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return letters || '?';
}

// Loose name-match for the "View company → Suppliers" deep-link on Join
// detail. Returns the matched supplier id if found in the provided list, or
// null. Pure function — caller passes the supplier list (no store coupling).
export function findSupplierMatch(
  suppliers: { id: string; name: string }[] | undefined,
  companyName: string | undefined,
): { id: string; name: string } | null {
  if (!suppliers || !companyName) return null;
  const norm = companyName.toLowerCase();
  return (
    suppliers.find(
      (s) =>
        norm.includes(s.name.toLowerCase().split(' ')[0]) ||
        s.name.toLowerCase().includes(norm.split(' ')[0]),
    ) ?? null
  );
}

// Type metadata — color, icon-name, tint per message type. Centralized so
// chips/icons/borders all stay in lockstep.
export const TYPE_META = {
  contact: { label: 'CONTACT', color: '#0a4a2e', tint: 'rgba(10,74,46,.08)' },
  join: { label: 'JOIN', color: '#a88d2e', tint: 'rgba(168,141,46,.10)' },
  keyword: { label: 'KEYWORD', color: '#44bd13', tint: 'rgba(68,189,19,.12)' },
  reply: { label: 'REPLY', color: '#6b7280', tint: 'rgba(107,114,128,.10)' },
  signup: { label: 'SIGNUP', color: '#153f80', tint: 'rgba(21,63,128,.10)' },
  welcome: { label: 'WELCOME', color: '#4d189e', tint: 'rgba(77,24,158,.10)' },
} as const;
