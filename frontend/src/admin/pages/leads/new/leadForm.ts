// The Add-lead form's rules — a PURE mirror of the server's `LeadCreate`
// (routes/admin_leads.py; contract .superpowers/sdd/2026-09-23-add-lead). The
// server is the authority; this copy exists so a rep mid-call learns about a
// bad ZIP in the field, not as an opaque 422 after a round trip.
//
// Mirror rules, 1:1 with the server:
//   • every string is stripped, and "" means absent (omitted from the body);
//   • lengths count CODE POINTS, as Python's len() does — `[...s].length`,
//     never `s.length` (an emoji is 2 UTF-16 units and 1 to the server);
//   • state is upper-cased BEFORE the two-letter rule, so "ny" is fine;
//   • ZIP is 5 digits or ZIP+4; the two email fields share one loose pattern.
//
// Inputs render as plain text fields with an inputMode and noValidate on the
// form (the browser's own typed fields swallow submit on a value they
// dislike — see CLAUDE.md), which is why every check lives here.

import type { LeadCreateBody, LeadExistsDetail, LeadTier } from '@admin/types/leads';

export type LeadTextField =
  | 'company_name'
  | 'street'
  | 'city'
  | 'state'
  | 'postal_code'
  | 'main_phone'
  | 'website'
  | 'sales_email'
  | 'contact_name'
  | 'contact_title'
  | 'direct_phone'
  | 'contact_email'
  | 'linkedin_url'
  | 'hours_tz'
  | 'notes';

export type LeadFormState = Record<LeadTextField, string> & { tier: LeadTier | '' };

export type LeadFormField = LeadTextField | 'tier';

export type LeadFormErrors = Partial<Record<LeadFormField, string>>;

/** Server max_lengths — the SAME numbers LeadCreate declares. */
export const LEAD_MAX: Record<LeadTextField, number> = {
  company_name: 200,
  street: 200,
  city: 80,
  state: 2,
  postal_code: 10,
  main_phone: 24,
  website: 200,
  sales_email: 200,
  contact_name: 120,
  contact_title: 120,
  direct_phone: 24,
  contact_email: 200,
  linkedin_url: 300,
  hours_tz: 40,
  notes: 4000,
};

const TEXT_FIELDS = Object.keys(LEAD_MAX) as LeadTextField[];

export const EMPTY_LEAD_FORM: LeadFormState = {
  company_name: '',
  tier: '',
  street: '',
  city: '',
  state: '',
  postal_code: '',
  main_phone: '',
  website: '',
  sales_email: '',
  contact_name: '',
  contact_title: '',
  direct_phone: '',
  contact_email: '',
  linkedin_url: '',
  hours_tz: '',
  notes: '',
};

// Same patterns as the server (Python `re`, ASCII-only classes on both sides).
const STATE_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Python len() — code points, not UTF-16 units. */
export function codePoints(value: string): number {
  return [...value].length;
}

/** What the server will store for this field: stripped, state upper-cased. */
function clean(field: LeadTextField, raw: string): string {
  const value = raw.trim();
  return field === 'state' ? value.toUpperCase() : value;
}

export function validateLeadForm(form: LeadFormState): LeadFormErrors {
  const errors: LeadFormErrors = {};

  for (const field of TEXT_FIELDS) {
    const value = clean(field, form[field]);
    if (!value) continue;
    const length = codePoints(value);
    const max = LEAD_MAX[field];
    if (length > max && field !== 'state' && field !== 'postal_code') {
      errors[field] = `Keep this to ${max.toLocaleString('en-US')} characters. It has ${length.toLocaleString('en-US')}.`;
    }
  }

  if (!clean('company_name', form.company_name)) {
    errors.company_name = 'Enter the company name.';
  }

  const state = clean('state', form.state);
  if (state && !STATE_RE.test(state)) {
    errors.state = 'Use the two-letter state code, like NY.';
  }

  const zip = clean('postal_code', form.postal_code);
  if (zip && !ZIP_RE.test(zip)) {
    errors.postal_code = 'Enter a 5-digit ZIP, or ZIP+4 like 11779-1234.';
  }

  for (const field of ['sales_email', 'contact_email'] as const) {
    const email = clean(field, form[field]);
    if (email && !errors[field] && !EMAIL_RE.test(email)) {
      errors[field] = 'Check this address. It should look like name@company.com.';
    }
  }

  return errors;
}

/** The POST body: trimmed values, empties OMITTED, no key LeadCreate lacks. */
export function buildLeadBody(form: LeadFormState): LeadCreateBody {
  const body: LeadCreateBody = { company_name: clean('company_name', form.company_name) };
  for (const field of TEXT_FIELDS) {
    if (field === 'company_name') continue;
    const value = clean(field, form[field]);
    if (value) body[field] = value;
  }
  if (form.tier) body.tier = form.tier;
  return body;
}

/**
 * "Save and add another contact": the next person at the same company keeps
 * the company and its address and starts with an empty contact + notes.
 */
export function carryCompany(form: LeadFormState): LeadFormState {
  return {
    ...EMPTY_LEAD_FORM,
    company_name: form.company_name,
    tier: form.tier,
    street: form.street,
    city: form.city,
    state: form.state,
    postal_code: form.postal_code,
    main_phone: form.main_phone,
    website: form.website,
    sales_email: form.sales_email,
    hours_tz: form.hours_tz,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the structured duplicate refusal off a response body. `null` for any
 * other status or shape — the caller then treats it as an ordinary failure.
 */
export function readLeadExists(status: number | undefined, data: unknown): LeadExistsDetail | null {
  if (status !== 409 || !isRecord(data) || !isRecord(data.detail)) return null;
  const detail = data.detail;
  if (detail.code === 'lead_exists_private') return { code: 'lead_exists_private' };
  if (detail.code !== 'lead_exists') return null;
  if (typeof detail.lead_id !== 'string' || typeof detail.company_name !== 'string') return null;
  return {
    code: 'lead_exists',
    lead_id: detail.lead_id,
    company_name: detail.company_name,
    contact_name: typeof detail.contact_name === 'string' ? detail.contact_name : null,
  };
}

const FORM_FIELDS = new Set<string>([...TEXT_FIELDS, 'tier']);

/**
 * A FastAPI 422 (`detail: [{loc, msg}]`) pinned onto the fields it names. The
 * mirror above should make this unreachable; it exists so a drift between the
 * two rule sets still lands on the right field instead of a bare banner.
 */
export function serverFieldErrors(data: unknown): LeadFormErrors {
  const errors: LeadFormErrors = {};
  if (!isRecord(data) || !Array.isArray(data.detail)) return errors;
  for (const item of data.detail) {
    if (!isRecord(item) || !Array.isArray(item.loc) || typeof item.msg !== 'string') continue;
    const field = item.loc[item.loc.length - 1];
    if (typeof field !== 'string' || !FORM_FIELDS.has(field)) continue;
    errors[field as LeadFormField] ??= item.msg.replace(/^Value error,\s*/i, '');
  }
  return errors;
}

/**
 * A forgiving comparison key for the "already on the call list" HINT only —
 * case, spacing and punctuation folded. The server's canon() stays the one
 * authority on what counts as a duplicate.
 */
export function looseKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
