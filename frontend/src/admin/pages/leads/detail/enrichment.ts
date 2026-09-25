// "Find contacts" — the PURE rules behind the panel's two actions. The panel
// never writes on its own: a candidate reaches the database only through the
// CRM's ordinary doors, and these functions build exactly what goes through.
//
//   • Use for this lead → PATCH /admin/leads/{id}. Offered on a company
//     placeholder (nobody on file yet), or when the candidate IS the lead's
//     own contact (the Email Finder's answer, or the same name). It only FILLS
//     empty fields: a rep's typed data is never overwritten by a guess.
//   • Add as a lead → POST /admin/leads/. A sibling at the same company, built
//     through the Add-lead form's own mirror (validateLeadForm/buildLeadBody),
//     so it meets the server's LeadCreate rules the same way a typed lead does.

import type {
  AdminLeadDetail,
  EnrichmentCandidate,
  EnrichmentDomainSource,
  LeadCreateBody,
  LeadEnrichment,
} from '@admin/types/leads';

import { formatEasternDate } from '../provenance';

import {
  EMPTY_LEAD_FORM,
  LEAD_MAX,
  buildLeadBody,
  codePoints,
  looseKey,
  validateLeadForm,
  type LeadFormField,
  type LeadFormState,
} from '../new/leadForm';

/** The contact fields a candidate can fill — `LeadUpdate` names, all of them. */
export type EnrichmentField =
  | 'contact_name'
  | 'contact_title'
  | 'contact_email'
  | 'direct_phone'
  | 'linkedin_url';

export type EnrichmentPatch = Partial<Record<EnrichmentField, string>>;

type LeadContactFields = Pick<AdminLeadDetail, 'id' | 'contact_name' | EnrichmentField>;

/** Is this candidate the lead's own contact? The server's roster match says
 *  so directly; a same-name answer (case, spacing, punctuation folded) too. */
export function isThisLeadsContact(candidate: EnrichmentCandidate, lead: LeadContactFields): boolean {
  if (candidate.existing_lead_id === lead.id) return true;
  return (
    candidate.full_name != null &&
    lead.contact_name != null &&
    looseKey(candidate.full_name) === looseKey(lead.contact_name)
  );
}

function fits(value: string | null, max: number): string | null {
  const v = (value ?? '').trim();
  return v && codePoints(v) <= max ? v : null;
}

/**
 * What "Use for this lead" would send, or null when it has nothing to offer
 * (not this lead's person, or every field it knows is already filled). A value
 * longer than the server allows is left out rather than clipped — a clipped
 * address or link is a wrong one.
 */
export function enrichmentPatch(
  candidate: EnrichmentCandidate,
  lead: LeadContactFields,
): EnrichmentPatch | null {
  const placeholder = lead.contact_name == null;
  if (!placeholder && !isThisLeadsContact(candidate, lead)) return null;
  if (placeholder && !candidate.full_name) return null;

  const offer: Record<EnrichmentField, string | null> = {
    contact_name: fits(candidate.full_name, LEAD_MAX.contact_name),
    contact_title: fits(candidate.position, LEAD_MAX.contact_title),
    contact_email: fits(candidate.email, LEAD_MAX.contact_email),
    direct_phone: fits(candidate.phone, LEAD_MAX.direct_phone),
    linkedin_url: fits(candidate.linkedin_url, LEAD_MAX.linkedin_url),
  };
  if (placeholder && !offer.contact_name) return null;

  const patch: EnrichmentPatch = {};
  for (const field of Object.keys(offer) as EnrichmentField[]) {
    const value = offer[field];
    const current = (lead[field] ?? '').trim();
    if (value && !current) patch[field] = value;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// Company context the sibling inherits — the same fields "Add and start
// another" keeps. Carried, not required: one that fails the form's rules is
// dropped instead of blocking the add.
const COMPANY_FIELDS = [
  'tier',
  'street',
  'city',
  'state',
  'postal_code',
  'main_phone',
  'website',
  'sales_email',
  'hours_tz',
] as const;

/**
 * The POST body for "Add as a lead": this candidate as a new contact at the
 * lead's company (its full "Head (Branch)" name, so the server files the same
 * branch). null when the candidate names nobody, or its own fields cannot
 * pass the form's rules.
 */
export function enrichmentCreateBody(
  candidate: EnrichmentCandidate,
  lead: AdminLeadDetail,
): LeadCreateBody | null {
  if (!candidate.full_name) return null;
  const form: LeadFormState = {
    ...EMPTY_LEAD_FORM,
    company_name: lead.company_name,
    contact_name: candidate.full_name,
    contact_title: candidate.position ?? '',
    contact_email: candidate.email,
    direct_phone: candidate.phone ?? '',
    linkedin_url: candidate.linkedin_url ?? '',
  };
  for (const field of COMPANY_FIELDS) {
    const value = lead[field];
    if (field === 'tier') {
      form.tier = value === 'S' || value === 'M' || value === 'L' ? value : '';
    } else {
      form[field] = value ?? '';
    }
  }

  let errors = validateLeadForm(form);
  for (const field of Object.keys(errors) as LeadFormField[]) {
    if ((COMPANY_FIELDS as readonly string[]).includes(field)) {
      if (field === 'tier') form.tier = '';
      else form[field as Exclude<(typeof COMPANY_FIELDS)[number], 'tier'>] = '';
    }
  }
  // An over-long optional detail from the provider is dropped, not fatal.
  for (const field of ['contact_title', 'direct_phone', 'linkedin_url'] as const) {
    if (errors[field]) form[field] = '';
  }
  errors = validateLeadForm(form);
  return Object.keys(errors).length === 0 ? buildLeadBody(form) : null;
}

const SOURCE_LABEL: Record<EnrichmentDomainSource, string | null> = {
  website: null,
  sales_email: 'from the sales email',
  contact_email: "from the contact's email",
  manufacturer: "from the manufacturer's website",
};

/** Where the searched domain came from, when it was not the lead's own
 *  website — said out loud, because a wrong domain means wrong people. */
export function domainSourceNote(source: EnrichmentDomainSource): string | null {
  return SOURCE_LABEL[source] ?? null;
}

/** Hunter's pattern as an address a rep can read: "{first}.{last}" at
 *  acme.com → "first.last@acme.com". null when there is none. */
export function patternExample(pattern: string | null, domain: string): string | null {
  const p = (pattern ?? '').trim();
  if (!p) return null;
  return `${p.replace(/[{}]/g, '')}@${domain}`;
}

/** A candidate's trust line: "92% · verified". */
export function confidenceLabel(candidate: Pick<EnrichmentCandidate, 'confidence' | 'verification'>): string {
  const parts: string[] = [];
  if (candidate.confidence != null) parts.push(`${candidate.confidence}%`);
  if (candidate.verification === 'valid') parts.push('verified');
  // accept_all: the company's mail server says yes to ANY address, so this
  // one cannot be checked — not the same as a bad one.
  else if (candidate.verification === 'accept_all') parts.push('unverifiable');
  return parts.join(' · ');
}

export interface EnrichmentFailure {
  message: string;
  /** Worth a "Try again" button (the provider hiccuped), vs fix-the-lead. */
  retry: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A failed search in the console's voice. The server writes the 422/502
 * sentences for a reader (`detail.message`); anything else — a network drop,
 * a 500 — gets our own. 401 and viewer refusals are the page's business
 * (classifyLeadsError), not this helper's.
 */
export function readEnrichmentFailure(status: number | undefined, data: unknown): EnrichmentFailure {
  const detail = record(record(data)?.detail);
  const message = typeof detail?.message === 'string' ? detail.message : null;
  if (status === 422 && message) return { message, retry: false };
  if (status === 502 && message) return { message, retry: detail?.reason !== 'quota' };
  return { message: "Hunter didn't answer; try again in a minute.", retry: true };
}

/** What the panel shows for a lead, decided by the server's `pending` list —
 *  the searches that would still spend a Hunter credit. */
export interface EnrichmentView {
  /** The company has been searched: show its stored list. */
  showResults: boolean;
  /** The one button that would spend a credit, or null when everything this
   *  lead needs is stored — the server refuses to search a company twice
   *  (owner, 2026-09-25), so no button is offered either. */
  searchLabel: string | null;
}

export function enrichmentView(
  result: Pick<LeadEnrichment, 'pending'>,
  contactName: string | null,
): EnrichmentView {
  if (result.pending.includes('domain-search')) {
    return { showResults: false, searchLabel: 'Search Hunter' };
  }
  if (result.pending.includes('email-finder')) {
    // The company is stored (a branch row, say); only this person is new.
    return { showResults: true, searchLabel: `Look up ${contactName ?? 'this contact'}\u2019s address` };
  }
  return { showResults: true, searchLabel: null };
}

/** "Searched Sep 25, 2026 by anthony" — who spent the credit, and when
 *  (Eastern day, like the lead's "Added by" line). "you" for the viewer. */
export function searchedNote(
  result: Pick<LeadEnrichment, 'searched_by' | 'searched_at'>,
  viewer?: string | null,
): string | null {
  const day = formatEasternDate(result.searched_at);
  const by = (result.searched_by ?? '').trim();
  const who = by && viewer && viewer === by ? 'you' : by;
  if (day && who) return `Searched ${day} by ${who}`;
  if (day) return `Searched ${day}`;
  return who ? `Searched by ${who}` : null;
}
