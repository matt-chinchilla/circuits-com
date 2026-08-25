// The two customer-registration message types (signup / welcome) reach the
// inbox helpers as ordinary union arms. These pin the strings the inbox
// prints for them, because every one of them has a second home: the list row,
// the bell dropdown and the detail heading all read the same helper, and the
// detail heading repeats the subject inline (pages/messages/detail).
//
// `welcome` is the one arm whose payload carries NO email — it is written to
// the customer's own inbox, not received from anyone — so senderEmail must
// answer for it explicitly rather than reaching for a field that is not there.

import { describe, expect, it } from 'vitest';
import type { Message } from '@admin/types/messages';
import { TYPE_META, initialsOf, senderEmail, senderName, subjectFor } from './messageHelpers';

const BASE = {
  id: '0d1f',
  seq: 42,
  status: 'new',
  created_at: '2026-08-25T12:00:00Z',
} as const;

const SIGNUP = {
  ...BASE,
  type: 'signup',
  payload: {
    first_name: 'Ada',
    last_name: 'Lovelace',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    country: 'GB',
  },
} as Message;

const WELCOME = {
  ...BASE,
  type: 'welcome',
  payload: { first_name: 'Ada', full_name: 'Ada Lovelace' },
} as Message;

describe('subjectFor', () => {
  it('names the person who signed up', () => {
    expect(subjectFor(SIGNUP)).toBe('Ada Lovelace signed up');
  });

  it('greets on the welcome row', () => {
    expect(subjectFor(WELCOME)).toBe('Welcome to Circuit Center');
  });
});

describe('senderName', () => {
  it('is the new customer on a signup', () => {
    expect(senderName(SIGNUP)).toBe('Ada Lovelace');
  });

  it('is the company on a welcome — the customer did not send it', () => {
    expect(senderName(WELCOME)).toBe('Circuit Center');
  });
});

describe('senderEmail', () => {
  it('reads the verified address off a signup', () => {
    expect(senderEmail(SIGNUP)).toBe('ada@example.com');
  });

  it('is a dash on a welcome, which carries no address at all', () => {
    // Guards against `m.payload.email` on a payload that has no such key —
    // that would print the literal "undefined" into a mailto: link.
    expect(senderEmail(WELCOME)).toBe('—');
  });
});

describe('TYPE_META', () => {
  it('carries a chip for both new types', () => {
    expect(TYPE_META.signup).toEqual({
      label: 'SIGNUP',
      color: '#153f80',
      tint: 'rgba(21,63,128,.10)',
    });
    expect(TYPE_META.welcome).toEqual({
      label: 'WELCOME',
      color: '#4d189e',
      tint: 'rgba(77,24,158,.10)',
    });
  });

  it('keeps every message type distinguishable by colour', () => {
    const colors = Object.values(TYPE_META).map((t) => t.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
  });

  it('ignores the middle name rather than growing the avatar', () => {
    expect(initialsOf('Ada Byron Lovelace')).toBe('AB');
  });

  it('survives a single name', () => {
    expect(initialsOf('Ada')).toBe('A');
  });

  it('survives extra whitespace', () => {
    expect(initialsOf('  Ada   Lovelace ')).toBe('AL');
  });

  it('falls back rather than rendering an empty avatar', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});
