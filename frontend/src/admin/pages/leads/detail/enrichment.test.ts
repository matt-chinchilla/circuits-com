import { describe, expect, it } from 'vitest';

import type { AdminLeadDetail, EnrichmentCandidate, EnrichmentKind } from '@admin/types/leads';

import {
  confidenceLabel,
  domainSourceNote,
  enrichmentCreateBody,
  enrichmentPatch,
  enrichmentView,
  isThisLeadsContact,
  patternExample,
  readEnrichmentFailure,
  searchedNote,
} from './enrichment';

function candidate(patch: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate {
  return {
    first_name: 'Ciaran',
    last_name: 'Lee',
    full_name: 'Ciaran Lee',
    email: 'ciaran@acme.com',
    position: 'Purchasing Manager',
    phone: '+1 631 555 0142',
    linkedin_url: 'https://www.linkedin.com/in/ciaranlee',
    confidence: 92,
    verification: 'valid',
    kind: 'personal',
    source: 'hunter',
    existing_lead_id: null,
    ...patch,
  };
}

function lead(patch: Partial<AdminLeadDetail> = {}): AdminLeadDetail {
  return {
    id: 'lead-1',
    company_name: 'Bisco Industries (Bohemia)',
    branch_label: 'Bohemia',
    company_slug: 'bisco industries',
    manufacturer_id: null,
    tier: 'S',
    ring: '2',
    city: 'Bohemia',
    state: 'NY',
    distance_miles: 4.2,
    contact_name: null,
    contact_title: null,
    needs_enrichment: true,
    last_outcome: null,
    last_contacted_at: null,
    contact_attempts: 0,
    street: '1 Main St',
    postal_code: '11716',
    main_phone: '631-555-0100',
    website: 'bisco.com',
    sales_email: 'sales@bisco.com',
    direct_phone: null,
    contact_email: null,
    linkedin_url: null,
    hours_tz: 'ET',
    notes: 'roster note',
    contacts: [],
    ...patch,
  };
}

describe('isThisLeadsContact', () => {
  it('trusts the server roster match', () => {
    expect(isThisLeadsContact(candidate({ existing_lead_id: 'lead-1' }), lead())).toBe(true);
  });

  it('matches the same name with case, spacing and punctuation folded', () => {
    expect(isThisLeadsContact(candidate(), lead({ contact_name: '  ciaran   LEE ' }))).toBe(true);
    expect(isThisLeadsContact(candidate(), lead({ contact_name: 'Ian Locke' }))).toBe(false);
  });

  it('a nameless address is nobody', () => {
    expect(isThisLeadsContact(candidate({ full_name: null }), lead({ contact_name: 'Ciaran Lee' }))).toBe(false);
  });
});

describe('enrichmentPatch — Use for this lead', () => {
  it('fills every contact field on a placeholder', () => {
    expect(enrichmentPatch(candidate(), lead())).toEqual({
      contact_name: 'Ciaran Lee',
      contact_title: 'Purchasing Manager',
      contact_email: 'ciaran@acme.com',
      direct_phone: '+1 631 555 0142',
      linkedin_url: 'https://www.linkedin.com/in/ciaranlee',
    });
  });

  it("never puts someone else's details on a named lead", () => {
    expect(enrichmentPatch(candidate(), lead({ contact_name: 'Ian Locke' }))).toBeNull();
  });

  it("fills only the empty fields of the lead's own contact", () => {
    const own = lead({
      contact_name: 'Ciaran Lee',
      contact_title: 'Buyer',
      direct_phone: '631-000-0000',
      needs_enrichment: false,
    });
    expect(enrichmentPatch(candidate(), own)).toEqual({
      contact_email: 'ciaran@acme.com',
      linkedin_url: 'https://www.linkedin.com/in/ciaranlee',
    });
  });

  it('is null when there is nothing left to fill', () => {
    const full = lead({
      contact_name: 'Ciaran Lee',
      contact_title: 'Buyer',
      contact_email: 'c@bisco.com',
      direct_phone: '1',
      linkedin_url: 'https://x.test',
    });
    expect(enrichmentPatch(candidate(), full)).toBeNull();
  });

  it('a generic address cannot become a placeholder person', () => {
    expect(enrichmentPatch(candidate({ full_name: null }), lead())).toBeNull();
  });

  it('leaves out a value the server would refuse instead of clipping it', () => {
    const patch = enrichmentPatch(candidate({ position: 'x'.repeat(121), phone: '1'.repeat(25) }), lead());
    expect(patch).not.toHaveProperty('contact_title');
    expect(patch).not.toHaveProperty('direct_phone');
    expect(patch?.contact_name).toBe('Ciaran Lee');
  });
});

describe('enrichmentCreateBody — Add as a lead', () => {
  it('adds the person at the same company and branch, carrying the company details', () => {
    expect(enrichmentCreateBody(candidate(), lead())).toEqual({
      company_name: 'Bisco Industries (Bohemia)',
      contact_name: 'Ciaran Lee',
      contact_title: 'Purchasing Manager',
      contact_email: 'ciaran@acme.com',
      direct_phone: '+1 631 555 0142',
      linkedin_url: 'https://www.linkedin.com/in/ciaranlee',
      tier: 'S',
      street: '1 Main St',
      city: 'Bohemia',
      state: 'NY',
      postal_code: '11716',
      main_phone: '631-555-0100',
      website: 'bisco.com',
      sales_email: 'sales@bisco.com',
      hours_tz: 'ET',
    });
  });

  it("never copies the lead's notes or someone else's photo", () => {
    const body = enrichmentCreateBody(candidate(), lead({ photo_url: 'data:image/png;base64,AA' }));
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('photo_url');
  });

  it('drops a carried company field the form would refuse instead of failing', () => {
    const body = enrichmentCreateBody(candidate(), lead({ postal_code: '1177', state: 'New York' }));
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty('postal_code');
    expect(body).not.toHaveProperty('state');
  });

  it('is null for a nameless address or an unusable email', () => {
    expect(enrichmentCreateBody(candidate({ full_name: null }), lead())).toBeNull();
    expect(enrichmentCreateBody(candidate({ email: 'not-an-email' }), lead())).toBeNull();
  });
});

describe('labels', () => {
  it('names the domain source only when it is not the website', () => {
    expect(domainSourceNote('website')).toBeNull();
    expect(domainSourceNote('manufacturer')).toBe("from the manufacturer's website");
  });

  it('turns the pattern into an address', () => {
    expect(patternExample('{first}.{last}', 'acme.com')).toBe('first.last@acme.com');
    expect(patternExample(null, 'acme.com')).toBeNull();
  });

  it('shows the confidence and a verified mark', () => {
    expect(confidenceLabel({ confidence: 92, verification: 'valid' })).toBe('92% · verified');
    expect(confidenceLabel({ confidence: 60, verification: 'unknown' })).toBe('60%');
    expect(confidenceLabel({ confidence: 71, verification: 'accept_all' })).toBe('71% · unverifiable');
    expect(confidenceLabel({ confidence: null, verification: null })).toBe('');
  });
});

describe('readEnrichmentFailure', () => {
  it("speaks the server's own sentence for a lead that needs fixing", () => {
    const data = { detail: { code: 'no_domain', message: 'No company domain on this lead — add its website first.' } };
    expect(readEnrichmentFailure(422, data)).toEqual({
      message: 'No company domain on this lead — add its website first.',
      retry: false,
    });
  });

  it('offers a retry for a provider hiccup, but not for a spent allowance', () => {
    expect(readEnrichmentFailure(502, { detail: { message: 'x', reason: 'timeout' } }).retry).toBe(true);
    expect(readEnrichmentFailure(502, { detail: { message: 'x', reason: 'quota' } }).retry).toBe(false);
  });

  it('never prints anything else the server said', () => {
    expect(readEnrichmentFailure(500, { detail: 'Traceback …' })).toEqual({
      message: "Hunter didn't answer; try again in a minute.",
      retry: true,
    });
    expect(readEnrichmentFailure(undefined, undefined).retry).toBe(true);
  });
});

/** Owner, 2026-09-25: "prevent people from searching companies that have
 *  already been searched for" — the button exists only while the server
 *  says a search would still spend on something. */
describe('enrichmentView', () => {
  const view = (pending: EnrichmentKind[], name: string | null = 'Ian Locke') =>
    enrichmentView({ pending }, name);

  it('offers the company search, and no list, before anyone has searched', () => {
    expect(view(['domain-search', 'email-finder'])).toEqual({
      showResults: false,
      searchLabel: 'Search Hunter',
    });
    expect(view(['domain-search'], null).searchLabel).toBe('Search Hunter');
  });

  it('shows the stored list and NO button once everything is stored', () => {
    expect(view([])).toEqual({ showResults: true, searchLabel: null });
  });

  it('shows the stored company and offers only the new person', () => {
    expect(view(['email-finder'])).toEqual({
      showResults: true,
      searchLabel: 'Look up Ian Locke\u2019s address',
    });
  });
});

describe('searchedNote', () => {
  it('says who spent the credit and on which Eastern day', () => {
    // 01:30 UTC on the 26th is still the 25th in New York.
    const r = { searched_by: 'anthony', searched_at: '2026-09-26T01:30:00+00:00' };
    expect(searchedNote(r)).toBe('Searched Sep 25, 2026 by anthony');
    expect(searchedNote(r, 'anthony')).toBe('Searched Sep 25, 2026 by you');
    expect(searchedNote(r, 'daniel')).toBe('Searched Sep 25, 2026 by anthony');
  });

  it('degrades without a name or a date, and is null before any search', () => {
    expect(searchedNote({ searched_by: null, searched_at: '2026-09-25T15:00:00Z' })).toBe(
      'Searched Sep 25, 2026',
    );
    expect(searchedNote({ searched_by: 'anthony', searched_at: null })).toBe('Searched by anthony');
    expect(searchedNote({ searched_by: null, searched_at: null })).toBeNull();
  });
});
