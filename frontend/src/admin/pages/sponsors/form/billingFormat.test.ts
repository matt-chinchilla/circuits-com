import { describe, expect, it } from 'vitest';
import {
  billingStatusLabel,
  billingTone,
  cancelsOn,
  cardLinkMailto,
  cents,
  formatDay,
  invoiceStatusLabel,
  parseDollarsToCents,
  refundableCents,
} from './billingFormat';

describe('cents', () => {
  it('renders whole cents as dollars with separators and two decimals', () => {
    expect(cents(210000)).toBe('$2,100.00');
    expect(cents(850000)).toBe('$8,500.00');
    expect(cents(5)).toBe('$0.05');
    expect(cents(0)).toBe('$0.00');
  });

  it('never prints NaN for a missing amount', () => {
    expect(cents(null)).toBe('—');
    expect(cents(undefined)).toBe('—');
    expect(cents(Number.NaN)).toBe('—');
  });
});

describe('formatDay', () => {
  it('reads ISO strings in UTC so the date never slips a day', () => {
    expect(formatDay('2026-09-01T00:00:00Z')).toBe('Sep 1');
    expect(formatDay('2026-09-01T00:00:00Z', { year: true })).toBe('Sep 1, 2026');
  });

  it('reads Stripe unix seconds too', () => {
    expect(formatDay(1788220800)).toBe('Sep 1'); // 2026-09-01T00:00:00Z
  });

  it('answers a dash for nothing', () => {
    expect(formatDay(null)).toBe('—');
    expect(formatDay('not a date')).toBe('—');
  });
});

describe('cancelsOn', () => {
  it('is the failing date plus the grace days', () => {
    expect(cancelsOn('2026-09-01T00:00:00Z', 14)).toBe('2026-09-15T00:00:00.000Z');
    expect(cancelsOn('2026-09-25T12:00:00Z', 14)).toBe('2026-10-09T12:00:00.000Z');
  });

  it('defaults to fourteen days and passes nothing through', () => {
    expect(cancelsOn('2026-09-01T00:00:00Z')).toBe('2026-09-15T00:00:00.000Z');
    expect(cancelsOn(null)).toBeNull();
    expect(cancelsOn('garbage')).toBeNull();
  });
});

describe('billingStatusLabel', () => {
  it('names the failing date and the cancel date', () => {
    expect(
      billingStatusLabel({ status: 'past_due', failing_since: '2026-09-01T00:00:00Z' }),
    ).toBe('Payment failing since Sep 1 · cancels Sep 15');
  });

  it('prefers the server’s own cancel date', () => {
    expect(
      billingStatusLabel({
        status: 'past_due',
        failing_since: '2026-09-01T00:00:00Z',
        cancels_on: '2026-09-16T00:00:00Z',
      }),
    ).toBe('Payment failing since Sep 1 · cancels Sep 16');
  });

  it('says when a scheduled cancel ends the sponsorship', () => {
    expect(
      billingStatusLabel({
        status: 'active',
        cancel_scheduled: true,
        cancel_at: '2026-10-23T00:00:00Z',
      }),
    ).toBe('Cancels Oct 23 · no further charges');
    expect(
      billingStatusLabel({ status: 'active', cancel_scheduled: true, period_end: '2026-10-23T00:00:00Z' }),
    ).toBe('Cancels Oct 23 · no further charges');
  });

  it('reads a healthy subscription as its renewal', () => {
    expect(billingStatusLabel({ status: 'active', period_end: '2026-10-23T00:00:00Z' })).toBe(
      'Active · renews Oct 23',
    );
    expect(billingStatusLabel({ status: 'active' })).toBe('Active');
  });

  it('covers the terminal and unusual states in plain words', () => {
    expect(billingStatusLabel({ status: 'canceled' })).toBe('Cancelled');
    expect(billingStatusLabel({ status: 'past_due' })).toBe('Payment past due');
    expect(billingStatusLabel({ status: 'unpaid' })).toBe('Unpaid');
    expect(billingStatusLabel({ status: 'incomplete' })).toBe('Waiting for the first payment');
    expect(billingStatusLabel({ status: 'something_new' })).toBe('Something new');
    expect(billingStatusLabel({ status: null })).toBe('No subscription');
  });
});

describe('billingTone', () => {
  it('maps states onto the three admin tones', () => {
    expect(billingTone({ status: 'active' })).toBe('ok');
    expect(billingTone({ status: 'active', cancel_scheduled: true })).toBe('warn');
    expect(billingTone({ status: 'active', failing_since: '2026-09-01T00:00:00Z' })).toBe('danger');
    expect(billingTone({ status: 'past_due' })).toBe('danger');
    expect(billingTone({ status: 'canceled' })).toBe('muted');
  });
});

describe('invoiceStatusLabel', () => {
  it('says what happened to the money', () => {
    expect(invoiceStatusLabel({ status: 'paid', amount_paid_cents: 210000, amount_refunded_cents: 0 })).toBe('Paid');
    expect(
      invoiceStatusLabel({ status: 'paid', amount_paid_cents: 210000, amount_refunded_cents: 210000 }),
    ).toBe('Refunded');
    expect(
      invoiceStatusLabel({ status: 'paid', amount_paid_cents: 210000, amount_refunded_cents: 5000 }),
    ).toBe('Partly refunded');
    expect(invoiceStatusLabel({ status: 'open', amount_paid_cents: 0, amount_refunded_cents: 0 })).toBe('Open');
    expect(invoiceStatusLabel({ status: 'void', amount_paid_cents: 0, amount_refunded_cents: 0 })).toBe('Void');
    expect(invoiceStatusLabel({ status: 'uncollectible', amount_paid_cents: 0, amount_refunded_cents: 0 })).toBe(
      'Uncollectible',
    );
  });
});

describe('refundableCents', () => {
  it('is what was paid less what already went back', () => {
    expect(refundableCents({ amount_paid_cents: 210000, amount_refunded_cents: 5000 })).toBe(205000);
    expect(refundableCents({ amount_paid_cents: 210000, amount_refunded_cents: 210000 })).toBe(0);
    expect(refundableCents({ amount_paid_cents: 0, amount_refunded_cents: 0 })).toBe(0);
    expect(refundableCents({ amount_paid_cents: 100, amount_refunded_cents: 400 })).toBe(0);
  });
});

describe('cardLinkMailto', () => {
  it('prefills the billing address, the subject and the link', () => {
    const href = cardLinkMailto(
      'ap+cc@acme.test',
      'https://circuitcenter.ai/api/billing/card/abc.def',
      '2026-09-30T00:00:00Z',
    );
    expect(href.startsWith('mailto:ap%2Bcc@acme.test?subject=')).toBe(true);
    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('subject')).toBe('Update the card for your Circuit Center sponsorship');
    expect(query.get('body')).toContain('https://circuitcenter.ai/api/billing/card/abc.def');
    expect(query.get('body')).toContain('Sep 30, 2026');
  });

  it('opens a blank draft when the supplier has no billing email', () => {
    expect(cardLinkMailto(null, 'https://x.test/c', null).startsWith('mailto:?subject=')).toBe(true);
  });
});

describe('parseDollarsToCents', () => {
  it('reads what a rep types into the partial-refund field', () => {
    expect(parseDollarsToCents('50')).toBe(5000);
    expect(parseDollarsToCents('$1,250.5')).toBe(125050);
    expect(parseDollarsToCents(' 20.00 ')).toBe(2000);
  });

  it('refuses anything that is not a positive amount', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('0')).toBeNull();
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
    expect(parseDollarsToCents('ten')).toBeNull();
  });
});
