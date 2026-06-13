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
  }
}

export function senderEmail(m: Message): string {
  return m.type === 'reply' ? m.payload.to : m.payload.email;
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
} as const;
