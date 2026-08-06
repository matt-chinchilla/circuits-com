/**
 * The legal entity behind circuitcenter.ai — ONE source, consumed by every
 * legal document, the footer, and the contact page.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An S-corp is being formed (accountant engaged 2026-08-05). Until the
 * paperwork clears, the business operates as a sole proprietorship and the
 * documents must say so truthfully. Rather than write the entity name into
 * four documents and re-paper all of them on incorporation, every document
 * reads it from here: incorporation is a one-line edit to `legalName` plus
 * `entityType`, and every page follows.
 *
 * Stripe rejects accounts whose name doesn't match across the legal entity,
 * the bank account, and the domain registrant. Whatever `legalName` says here
 * must be the same string on the Stripe account and the bank account — this
 * file is the record of what that string is supposed to be.
 */

/** How the business is legally organized right now. */
export type EntityType = 'sole proprietorship' | 'S corporation';

export interface MailingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Postal address for legal notices.
 *
 * DELIBERATELY NULL. A commercial mail address has been chosen but not yet
 * opened, and the previous value here was a fabricated street address
 * ("1 Industry Park Way, Brookhaven, NY 11719") carried over from a design
 * mockup. It sat in the notice clause of the published privacy policy, which
 * is worse than having no address at all: an unreachable notice address looks
 * like a real one to anyone trying to serve a notice, and looks like a false
 * statement to anyone who checks.
 *
 * While this is null the documents omit the postal clause entirely and route
 * notices to email. Set it once the box is open — Stripe account activation
 * needs a real address anyway, so this unblocks two things at once.
 *
 * Guard: `businessInfo.test.ts` fails if a fabricated placeholder returns.
 */
export const MAILING_ADDRESS: MailingAddress | null = null;

/** Known-fake addresses that must never ship again. Consumed by the guard test. */
export const FABRICATED_ADDRESS_FRAGMENTS = [
  '1 Industry Park Way',
  'Brookhaven, NY 11719',
] as const;

export const LEGAL_ENTITY = {
  /** Trading name shown in prose and page furniture. */
  name: 'Circuit Center',
  /**
   * The name on the Stripe account, the bank account, and every contract.
   * On incorporation this becomes 'Circuit Center, Inc.' and `entityType`
   * becomes 'S corporation'. Nothing else in the codebase changes.
   */
  legalName: 'Circuit Center',
  entityType: 'sole proprietorship' as EntityType,
  /** Governing law for the terms. Where the business is organized and operated. */
  jurisdiction: 'the State of New York',
  venue: 'Suffolk County, New York',
  site: 'circuitcenter.ai',
  origin: 'https://circuitcenter.ai',
} as const;

export const CONTACT_EMAILS = {
  general: 'hello@circuitcenter.ai',
  privacy: 'privacy@circuitcenter.ai',
  legal: 'legal@circuitcenter.ai',
  billing: 'billing@circuitcenter.ai',
  /** Where advertisers and readers report a policy-violating placement. */
  abuse: 'abuse@circuitcenter.ai',
} as const;

/**
 * Renders the mailing address as one line, or null when unset.
 * Callers MUST handle null rather than substituting filler.
 */
export function formatMailingAddress(): string | null {
  const a = MAILING_ADDRESS;
  if (!a) return null;
  const street = a.line2 ? `${a.line1}, ${a.line2}` : a.line1;
  return `${street}, ${a.city}, ${a.state} ${a.postalCode}, ${a.country}`;
}

/**
 * Builds the "send notices here" sentence used by every legal document, so
 * the null-address case is handled in exactly one place instead of three.
 */
export function noticeClause(email: string): string {
  const postal = formatMailingAddress();
  return postal
    ? `Notices may be sent to ${email} or by mail to ${LEGAL_ENTITY.legalName}, ${postal}.`
    : `Notices may be sent to ${email}.`;
}

/**
 * Effective dates are PINNED per document, never `new Date()`.
 *
 * The prior implementation formatted `new Date()` at render, so the published
 * policy claimed an effective date of whatever day you happened to load it —
 * and the prerendered HTML froze whatever day the site was last built. A term
 * you cannot date is a term you cannot enforce, and a document that appears to
 * be revised daily reads as one nobody is maintaining.
 *
 * Bump these by hand when a document actually changes, alongside its version.
 */
export const DOC_DATES = {
  privacy: '2026-05-12',
  terms: '2026-08-05',
  acceptableUse: '2026-08-05',
} as const;

export const DOC_VERSIONS = {
  privacy: '1.0',
  terms: '1.0',
  acceptableUse: '1.0',
} as const;

/** Formats a pinned ISO date for display. Parsed as UTC to avoid an off-by-one. */
export function formatDocDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
