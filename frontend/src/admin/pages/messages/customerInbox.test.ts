import { describe, expect, it } from 'vitest';
import type { AccountMessage } from '@admin/types/account';
import {
  httpStatusOf,
  humanLabel,
  inboxSubject,
  isStyledType,
  payloadText,
  unreadCount,
} from './customerInbox';

function msg(over: Partial<AccountMessage> = {}): AccountMessage {
  return {
    id: 'm1',
    type: 'welcome',
    read: false,
    created_at: '2026-08-25T10:00:00Z',
    payload: {},
    ...over,
  };
}

describe('isStyledType', () => {
  it('accepts the kinds the shared chips know', () => {
    expect(isStyledType('welcome')).toBe(true);
    expect(isStyledType('contact')).toBe(true);
  });

  it('rejects a kind that does not exist yet', () => {
    // The inbox is specified to carry receipts and payment confirmations that
    // have no chip — the caller prints the name instead of a coloured chip.
    expect(isStyledType('payment_receipt')).toBe(false);
    expect(isStyledType('')).toBe(false);
  });
});

describe('payloadText', () => {
  it('reads a non-empty string field', () => {
    expect(payloadText({ first_name: ' Dana ' }, 'first_name')).toBe('Dana');
  });

  it('refuses anything that is not usable text', () => {
    // JSON null is the one `?:` does not catch, and it is what the API sends
    // for an absent column.
    expect(payloadText({ first_name: null }, 'first_name')).toBeNull();
    expect(payloadText({ first_name: '   ' }, 'first_name')).toBeNull();
    expect(payloadText({ amount: 250 }, 'amount')).toBeNull();
    expect(payloadText({}, 'first_name')).toBeNull();
  });
});

describe('humanLabel', () => {
  it('prints an unknown wire type as its own name', () => {
    expect(humanLabel('payment_receipt')).toBe('Payment receipt');
    expect(humanLabel('sponsorship-renewal')).toBe('Sponsorship renewal');
  });

  it('never prints an empty heading', () => {
    expect(humanLabel('')).toBe('Message');
  });
});

describe('inboxSubject', () => {
  it('titles the welcome row without reading a subject it does not carry', () => {
    // routes/auth.py writes {first_name, full_name} and nothing else.
    expect(inboxSubject(msg({ payload: { first_name: 'Dana', full_name: 'Dana Reed' } }))).toBe(
      'Welcome to Circuit Center',
    );
  });

  it('prefers a real subject, then a title, then the type', () => {
    expect(inboxSubject(msg({ type: 'contact', payload: { subject: 'Quote request' } }))).toBe(
      'Quote request',
    );
    expect(inboxSubject(msg({ type: 'receipt', payload: { title: 'August invoice' } }))).toBe(
      'August invoice',
    );
    expect(inboxSubject(msg({ type: 'payment_failed', payload: {} }))).toBe('Payment failed');
  });
});

describe('unreadCount', () => {
  it('counts only the unread', () => {
    expect(unreadCount([msg({ read: false }), msg({ read: true }), msg({ read: false })])).toBe(2);
    expect(unreadCount([])).toBe(0);
  });
});

describe('httpStatusOf', () => {
  it('reads the status off a rejected request', () => {
    expect(httpStatusOf({ response: { status: 404 } })).toBe(404);
  });

  it('is undefined for a network error, which has no response at all', () => {
    expect(httpStatusOf(new Error('Network Error'))).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
  });
});
