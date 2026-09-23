import { describe, expect, it } from 'vitest';
import {
  absoluteLink,
  codeStatusChip,
  expiresLabel,
  locksSummary,
  normalizeAttention,
  pointsLabel,
  usesLabel,
} from './salesCodes';

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

  it('names points off list', () => {
    expect(pointsLabel(1)).toBe('1 pt off list');
    expect(pointsLabel(15)).toBe('15 pts off list');
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
