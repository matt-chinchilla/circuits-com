import { describe, expect, it } from 'vitest';

import {
  EMPTY_LEAD_FORM,
  LEAD_MAX,
  buildLeadBody,
  carryCompany,
  looseKey,
  readLeadExists,
  serverFieldErrors,
  validateLeadForm,
  type LeadFormState,
} from './leadForm';

function form(patch: Partial<LeadFormState>): LeadFormState {
  return { ...EMPTY_LEAD_FORM, ...patch };
}

// The server's LeadCreate bounds (contract.md, "Backend"). The mirror is only
// worth having if these two tables agree to the character.
const SERVER_MAX = {
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
} as const;

describe('LEAD_MAX mirrors the server bounds', () => {
  it('names the same fields with the same limits', () => {
    expect(LEAD_MAX).toEqual(SERVER_MAX);
  });
});

describe('validateLeadForm', () => {
  it('passes a company-only lead', () => {
    expect(validateLeadForm(form({ company_name: 'Bisco Industries' }))).toEqual({});
  });

  it('requires a company name, after trimming', () => {
    expect(validateLeadForm(form({ company_name: '   ' })).company_name).toMatch(/company name/i);
  });

  it('counts code points, like Python len()', () => {
    // 200 astral characters are 400 UTF-16 units but 200 to the server.
    const astral = '\u{1F50C}'.repeat(200);
    expect(validateLeadForm(form({ company_name: astral })).company_name).toBeUndefined();
    expect(validateLeadForm(form({ company_name: `${astral}x` })).company_name).toMatch(/200/);
  });

  it('checks every bounded field after the strip', () => {
    const long = (n: number) => 'a'.repeat(n);
    const errors = validateLeadForm(
      form({
        company_name: 'Acme',
        street: long(201),
        city: long(81),
        contact_name: long(121),
        contact_title: long(121),
        main_phone: long(25),
        direct_phone: long(25),
        website: long(201),
        linkedin_url: long(301),
        hours_tz: long(41),
        notes: long(4001),
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        'city',
        'contact_name',
        'contact_title',
        'direct_phone',
        'hours_tz',
        'linkedin_url',
        'main_phone',
        'notes',
        'street',
        'website',
      ].sort(),
    );
    // Padding does not count — the server strips first.
    expect(validateLeadForm(form({ company_name: 'Acme', city: `  ${long(80)}  ` }))).toEqual({});
  });

  it('upper-cases the state before the two-letter rule', () => {
    expect(validateLeadForm(form({ company_name: 'A', state: 'ny' })).state).toBeUndefined();
    expect(validateLeadForm(form({ company_name: 'A', state: 'N' })).state).toMatch(/two-letter/i);
    expect(validateLeadForm(form({ company_name: 'A', state: 'N1' })).state).toMatch(/two-letter/i);
    expect(validateLeadForm(form({ company_name: 'A', state: 'NYC' })).state).toMatch(/two-letter/i);
  });

  it('takes a 5-digit ZIP or ZIP+4 and nothing else', () => {
    const zip = (postal_code: string) => validateLeadForm(form({ company_name: 'A', postal_code })).postal_code;
    expect(zip('11779')).toBeUndefined();
    expect(zip('11779-1234')).toBeUndefined();
    expect(zip(' 11779 ')).toBeUndefined();
    expect(zip('1177')).toMatch(/ZIP/);
    expect(zip('11779 1234')).toMatch(/ZIP/);
    expect(zip('K1A 0B1')).toMatch(/ZIP/);
  });

  it('checks both email fields with the server pattern', () => {
    const ok = validateLeadForm(
      form({ company_name: 'A', sales_email: 'sales@acme.com', contact_email: 'ian.locke@fdh.aero' }),
    );
    expect(ok).toEqual({});
    const bad = validateLeadForm(
      form({ company_name: 'A', sales_email: 'sales@acme', contact_email: 'ian locke@fdh.aero' }),
    );
    expect(bad.sales_email).toMatch(/name@company\.com/);
    expect(bad.contact_email).toMatch(/name@company\.com/);
    expect(validateLeadForm(form({ company_name: 'A', contact_email: 'a@@b.com' })).contact_email).toBeDefined();
  });

  it('leaves blank optional fields alone', () => {
    expect(validateLeadForm(form({ company_name: 'A', state: '  ', postal_code: '', sales_email: ' ' }))).toEqual({});
  });
});

describe('buildLeadBody', () => {
  it('trims every value and omits the empty ones', () => {
    const body = buildLeadBody(
      form({
        company_name: '  FDH Electronics (Ronkonkoma) ',
        contact_name: ' Ian Locke ',
        city: '',
        notes: '   ',
        state: 'ny',
        tier: 'M',
      }),
    );
    expect(body).toEqual({
      company_name: 'FDH Electronics (Ronkonkoma)',
      contact_name: 'Ian Locke',
      state: 'NY',
      tier: 'M',
    });
  });

  it('never sends a key the server does not know (extra="forbid")', () => {
    const everything = buildLeadBody(
      form(Object.fromEntries(Object.keys(SERVER_MAX).map((k) => [k, 'x'])) as Partial<LeadFormState>),
    );
    const allowed = new Set([...Object.keys(SERVER_MAX), 'tier']);
    for (const key of Object.keys(everything)) expect(allowed.has(key)).toBe(true);
  });

  it('omits an unset size', () => {
    expect('tier' in buildLeadBody(form({ company_name: 'A', tier: '' }))).toBe(false);
  });
});

describe('readLeadExists', () => {
  it('reads the staff-visible duplicate', () => {
    expect(
      readLeadExists(409, {
        detail: { code: 'lead_exists', lead_id: 'abc', company_name: 'FDH Electronics', contact_name: 'Ian Locke' },
      }),
    ).toEqual({ code: 'lead_exists', lead_id: 'abc', company_name: 'FDH Electronics', contact_name: 'Ian Locke' });
  });

  it('keeps a company-only duplicate company-only', () => {
    expect(
      readLeadExists(409, {
        detail: { code: 'lead_exists', lead_id: 'abc', company_name: 'Bisco', contact_name: null },
      }),
    ).toEqual({ code: 'lead_exists', lead_id: 'abc', company_name: 'Bisco', contact_name: null });
  });

  it('reads the private duplicate without inventing an id', () => {
    expect(readLeadExists(409, { detail: { code: 'lead_exists_private' } })).toEqual({ code: 'lead_exists_private' });
  });

  it('ignores anything that is not that 409', () => {
    expect(readLeadExists(422, { detail: { code: 'lead_exists', lead_id: 'x', company_name: 'A' } })).toBeNull();
    expect(readLeadExists(409, { detail: 'Some other conflict' })).toBeNull();
    expect(readLeadExists(409, { detail: { code: 'lead_exists' } })).toBeNull();
    expect(readLeadExists(409, undefined)).toBeNull();
  });
});

describe('serverFieldErrors', () => {
  it('maps a FastAPI 422 onto the fields it names', () => {
    const errors = serverFieldErrors({
      detail: [
        { loc: ['body', 'postal_code'], msg: 'Value error, not a ZIP', type: 'value_error' },
        { loc: ['body', 'nonsense'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' },
      ],
    });
    expect(errors).toEqual({ postal_code: 'not a ZIP' });
  });

  it('returns nothing for a string detail', () => {
    expect(serverFieldErrors({ detail: 'nope' })).toEqual({});
  });
});

describe('carryCompany', () => {
  it('keeps the company and its place, clears the person', () => {
    const next = carryCompany(
      form({
        company_name: 'FDH',
        tier: 'M',
        city: 'Ronkonkoma',
        state: 'NY',
        contact_name: 'Ian Locke',
        direct_phone: '555-0100',
        notes: 'Call back Tuesday',
      }),
    );
    expect(next.company_name).toBe('FDH');
    expect(next.tier).toBe('M');
    expect(next.city).toBe('Ronkonkoma');
    expect(next.contact_name).toBe('');
    expect(next.direct_phone).toBe('');
    expect(next.notes).toBe('');
  });
});

describe('looseKey', () => {
  it('folds case, spacing and punctuation for the on-the-list hint', () => {
    expect(looseKey('  FDH  Electronics, Inc. ')).toBe(looseKey('fdh electronics inc'));
    expect(looseKey('Bisco')).not.toBe(looseKey('Bisco Industries'));
  });
});
