import { describe, expect, it } from 'vitest';
import {
  absoluteLink,
  codeCreateBody,
  codeFormErrors,
  codePriceRows,
  type CodeFormState,
  codeStatusChip,
  expiresLabel,
  locksSummary,
  normalizeAttention,
  pointsLabel,
  usesLabel,
} from './salesCodes';
import { priceRowText } from '@admin/components/ListSelect/priceRows';

describe('codeStatusChip', () => {
  it('maps every server status onto a label and a tone', () => {
    expect(codeStatusChip('live')).toEqual({ label: 'Live', tone: 'ok' });
    expect(codeStatusChip('used_up')).toEqual({ label: 'Used up', tone: 'info' });
    expect(codeStatusChip('expired')).toEqual({ label: 'Expired', tone: 'muted' });
    expect(codeStatusChip('off')).toEqual({ label: 'Switched off', tone: 'muted' });
  });

  it('never prints a raw code for a status it has not met', () => {
    expect(codeStatusChip('paused_for_review')).toEqual({ label: 'Paused for review', tone: 'muted' });
  });
});

describe('absoluteLink', () => {
  it('prefixes the site origin onto the server’s ready path', () => {
    expect(absoluteLink('/join?code=AB1C-D2EF&tier=gold&slot=abc', 'https://circuitcenter.ai')).toBe(
      'https://circuitcenter.ai/join?code=AB1C-D2EF&tier=gold&slot=abc',
    );
    expect(absoluteLink('join?code=AB1C-D2EF', 'https://circuitcenter.ai/')).toBe(
      'https://circuitcenter.ai/join?code=AB1C-D2EF',
    );
  });

  it('leaves an already absolute link alone', () => {
    expect(absoluteLink('https://circuitcenter.ai/join?code=X', 'http://localhost')).toBe(
      'https://circuitcenter.ai/join?code=X',
    );
  });
});

describe('usesLabel / pointsLabel', () => {
  it('reads as a count', () => {
    expect(usesLabel({ uses: 0, max_uses: 1 })).toBe('0 of 1 used');
    expect(usesLabel({ uses: 3, max_uses: 5 })).toBe('3 of 5 used');
  });

  it('says the extra discount as a percent of list, never points', () => {
    expect(pointsLabel(1)).toBe('1% off list');
    expect(pointsLabel(15)).toBe('15% off list');
  });
});

describe('locksSummary', () => {
  const base = {
    tier: null,
    category_name: null,
    supplier_name: null,
    email_lock: null,
  } as const;

  it('says the code works anywhere when nothing is locked', () => {
    expect(locksSummary(base)).toEqual(['Any Gold or Platinum slot']);
  });

  it('lists each lock in the order a rep checks them', () => {
    expect(
      locksSummary({
        tier: 'gold',
        category_name: 'Zener Diodes',
        supplier_name: 'Acme',
        email_lock: 'buyer@acme.test',
      }),
    ).toEqual(['Gold', 'Zener Diodes', 'Acme', 'buyer@acme.test']);
    expect(locksSummary({ ...base, tier: 'platinum' })).toEqual(['Platinum']);
  });
});

describe('expiresLabel', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  it('looks forward or back from now', () => {
    expect(expiresLabel('2026-10-07T12:00:00Z', now)).toBe('Expires Oct 7');
    expect(expiresLabel('2026-09-20T12:00:00Z', now)).toBe('Expired Sep 20');
  });
});

describe('new-code form helpers', () => {
  const blank: CodeFormState = {
    points: 10,
    tier: 'any',
    categoryId: '',
    supplierId: '',
    emailLock: '',
    maxUses: '1',
    expiresInDays: 14,
    rep: 'Daniel',
    note: '',
  };

  it('accepts the simplest code', () => {
    expect(codeFormErrors(blank)).toEqual({});
    expect(codeCreateBody(blank)).toEqual({
      code_points: 10,
      max_uses: 1,
      expires_in_days: 14,
      rep: 'Daniel',
    });
  });

  it('asks for the customer email when a company is bound (R7), in the server’s words', () => {
    expect(codeFormErrors({ ...blank, supplierId: 's1' }).emailLock).toBe(
      "A code tied to a company needs the customer's email.",
    );
    expect(codeFormErrors({ ...blank, emailLock: 'not-an-email' }).emailLock).toBeTruthy();
  });

  it('needs a tier before a placement can be locked', () => {
    expect(codeFormErrors({ ...blank, categoryId: 'c1' }).categoryId).toBeTruthy();
    expect(codeFormErrors({ ...blank, tier: 'gold', categoryId: 'c1' })).toEqual({});
  });

  it('bounds the use count', () => {
    expect(codeFormErrors({ ...blank, maxUses: '0' }).maxUses).toBeTruthy();
    expect(codeFormErrors({ ...blank, maxUses: '2.5' }).maxUses).toBeTruthy();
    expect(codeFormErrors({ ...blank, maxUses: '101' }).maxUses).toBeTruthy();
  });

  it('sends every lock that is set, trimmed', () => {
    expect(
      codeCreateBody({
        ...blank,
        tier: 'platinum',
        categoryId: 'c1',
        supplierId: 's1',
        emailLock: ' AP@Acme.test ',
        maxUses: '3',
        note: '  trade show  ',
      }),
    ).toEqual({
      code_points: 10,
      tier: 'platinum',
      category_id: 'c1',
      supplier_id: 's1',
      email_lock: 'AP@Acme.test',
      max_uses: 3,
      expires_in_days: 14,
      rep: 'Daniel',
      note: 'trade show',
    });
  });

  it('prices each discount step from the server’s ladder, dollars first', () => {
    const tiers = {
      gold: { list: 2500, founder: 2100, floor: 1750, options: [{ code_points: 10, price_usd: 1850 }] },
      platinum: { list: 10000, founder: 8500, floor: 7000, options: [{ code_points: 10, price_usd: 7500 }] },
    };
    expect(codePriceRows(tiers, 'any', [10]).map(priceRowText)).toEqual([
      'Gold $1,850 · Platinum $7,500 | 10%',
    ]);
    expect(codePriceRows(tiers, 'gold', [10]).map(priceRowText)).toEqual(['$1,850 | 10%']);
    // Before the ladder loads the rows still say the percent — never a made-up price.
    expect(codePriceRows(null, 'any', [1]).map(priceRowText)).toEqual(['1%']);
    expect(codePriceRows(undefined, 'platinum', [3]).map(priceRowText)).toEqual(['3%']);
  });
});

describe('normalizeAttention', () => {
  it('reads the three queues and counts them', () => {
    const out = normalizeAttention({
      conflicts: [
        {
          id: 'i1',
          company_name: 'Acme',
          tier: 'gold',
          category_name: 'Zener Diodes',
          conflict_reason: 'slot_taken',
          price_usd: 2100,
          created_at: '2026-09-23T10:00:00Z',
        },
      ],
      holds: [
        {
          id: 'i2',
          company_name: 'Beta',
          tier: 'platinum',
          category_name: 'Connectors',
          expires_at: '2026-09-23T13:00:00Z',
          email: 'ops@beta.test',
        },
      ],
      failing: [
        {
          sponsor_id: 's1',
          company: 'Gamma',
          tier: 'Gold',
          failing_since: '2026-09-10T00:00:00Z',
          cancels_on: '2026-09-24T00:00:00Z',
        },
      ],
    });
    expect(out.total).toBe(3);
    expect(out.conflicts[0]).toMatchObject({
      id: 'i1',
      company: 'Acme',
      tier: 'Gold',
      place: 'Zener Diodes',
      reason: 'Someone else took the slot first',
      priceUsd: 2100,
    });
    expect(out.holds[0]).toMatchObject({ id: 'i2', company: 'Beta', tier: 'Platinum', until: '2026-09-23T13:00:00Z' });
    expect(out.failing[0]).toMatchObject({
      sponsorId: 's1',
      company: 'Gamma',
      failingSince: '2026-09-10T00:00:00Z',
      cancelsOn: '2026-09-24T00:00:00Z',
    });
  });

  it('tolerates alternate field names, missing queues and junk rows', () => {
    const out = normalizeAttention({
      conflicts: [{ intent_id: 'i9', company: 'Delta', reason: 'amount_mismatch' }, 'junk' as never],
      failing: [{ id: 's9', supplier_name: 'Echo', failing_since: '2026-09-01T00:00:00Z' }],
    });
    expect(out.holds).toEqual([]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ id: 'i9', company: 'Delta', reason: 'The amount paid did not match the price' });
    expect(out.failing[0]).toMatchObject({ sponsorId: 's9', company: 'Echo', cancelsOn: '2026-09-15T00:00:00.000Z' });
  });

  it('drops a row it cannot act on (no id)', () => {
    expect(normalizeAttention({ holds: [{ company_name: 'Nobody' }] }).total).toBe(0);
    expect(normalizeAttention(null).total).toBe(0);
  });
});
