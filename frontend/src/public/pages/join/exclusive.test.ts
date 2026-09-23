import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCLUSIVE_STASH_KEY,
  STASH_TTL_MS,
  checkoutErrorMessage,
  groupSlots,
  money,
  normalizeCodeInput,
  parseStash,
  readJoinParams,
  type SlotRow,
} from './exclusive';

const row = (over: Partial<SlotRow>): SlotRow => ({
  category_id: 'id',
  name: 'Name',
  parent_name: null,
  path: '/category/x',
  state: 'open',
  held_until: null,
  ...over,
});

describe('money', () => {
  it('adds thousands separators and no cents', () => {
    expect(money(2100)).toBe('$2,100');
    expect(money(8500)).toBe('$8,500');
    expect(money(10000)).toBe('$10,000');
    expect(money(210)).toBe('$210');
  });
});

describe('normalizeCodeInput', () => {
  it('upper-cases, strips spaces and re-dashes an 8-character code', () => {
    expect(normalizeCodeInput(' ab1c d2ef')).toBe('AB1C-D2EF');
    expect(normalizeCodeInput('AB1C-D2EF')).toBe('AB1C-D2EF');
    expect(normalizeCodeInput('ab1c_d2ef ')).toBe('AB1C-D2EF');
    expect(normalizeCodeInput('ab1c\u2013d2ef')).toBe('AB1C-D2EF');
  });

  it('maps the read-side confusables the server maps (O→0, I/L→1)', () => {
    expect(normalizeCodeInput('oooollll')).toBe('0000-1111');
    expect(normalizeCodeInput('iiii-OOOO')).toBe('1111-0000');
  });

  it('leaves a partial code undashed', () => {
    expect(normalizeCodeInput('ab1c')).toBe('AB1C');
    expect(normalizeCodeInput('')).toBe('');
  });
});

describe('groupSlots', () => {
  it('groups Gold by parent category and keeps held rows', () => {
    const rows = [
      row({ category_id: 'a', name: 'Op amps', parent_name: 'Amplifiers' }),
      row({ category_id: 'b', name: 'Relays', parent_name: 'Switches' }),
      row({
        category_id: 'c',
        name: 'Comparators',
        parent_name: 'Amplifiers',
        state: 'held',
        held_until: '2026-09-23T20:00:00Z',
      }),
    ];
    const groups = groupSlots(rows, 'gold');
    expect(groups.map(g => g.name)).toEqual(['Amplifiers', 'Switches']);
    expect(groups[0].rows.map(r => r.category_id)).toEqual(['a', 'c']);
    expect(groups.flatMap(g => g.rows)).toHaveLength(3);
  });

  it('lists Platinum flat, in server order, dropping nothing', () => {
    const rows = [
      row({ category_id: 'p1', name: 'Sensors' }),
      row({ category_id: 'p2', name: 'Connectors', state: 'held', held_until: 'x' }),
    ];
    const groups = groupSlots(rows, 'platinum');
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.category_id)).toEqual(['p1', 'p2']);
  });

  it('returns no groups for no rows', () => {
    expect(groupSlots([], 'gold')).toEqual([]);
    expect(groupSlots([], 'platinum')).toEqual([]);
  });
});

describe('readJoinParams', () => {
  it('parses the rep link and the Stripe return params', () => {
    expect(readJoinParams('?code=ab1c-d2ef&tier=gold&slot=x&released=1')).toEqual({
      code: 'ab1c-d2ef',
      tier: 'gold',
      slot: 'x',
      released: true,
    });
    expect(readJoinParams('?welcome=platinum')).toEqual({ welcome: 'platinum' });
    expect(readJoinParams('?card=updated')).toEqual({ card: 'updated' });
  });

  it('ignores unknown tiers and values', () => {
    expect(readJoinParams('?tier=diamond&welcome=silver&card=nope&released=0')).toEqual({});
    expect(readJoinParams('?tier=GOLD')).toEqual({ tier: 'gold' });
    expect(readJoinParams('')).toEqual({});
    expect(readJoinParams('?code=%20%20&slot=')).toEqual({});
  });

  it('refuses an absurdly long code or slot', () => {
    expect(readJoinParams(`?code=${'A'.repeat(65)}`)).toEqual({});
    expect(readJoinParams(`?slot=${'a'.repeat(65)}`)).toEqual({});
  });
});

describe('parseStash', () => {
  const now = 1_000_000_000_000;

  it('reads a fresh stash', () => {
    const raw = JSON.stringify({ tier: 'gold', release_token: 't', price_usd: 2100, ts: now - 1000 });
    expect(parseStash(raw, now)).toMatchObject({ tier: 'gold', release_token: 't', price_usd: 2100 });
  });

  it('drops a stale, malformed or absent one', () => {
    expect(parseStash(null, now)).toBeNull();
    expect(parseStash('{nope', now)).toBeNull();
    expect(parseStash('"str"', now)).toBeNull();
    expect(parseStash(JSON.stringify({ tier: 'gold' }), now)).toBeNull();
    expect(parseStash(JSON.stringify({ tier: 'gold', ts: now - STASH_TTL_MS - 1 }), now)).toBeNull();
    expect(parseStash(JSON.stringify({ tier: 'silver', ts: now }), now)).toBeNull();
  });

  it('uses its own key, never the Silver one', () => {
    expect(EXCLUSIVE_STASH_KEY).toBe('cc.exclusiveCheckout');
  });
});

describe('checkoutErrorMessage', () => {
  it('names each refusal the spec lists', () => {
    expect(checkoutErrorMessage(409, 'slot_taken')).toMatch(/just taken/);
    expect(checkoutErrorMessage(409, 'slot_held', '2026-09-23T20:00:00Z')).toMatch(
      /^Being purchased — held until /,
    );
    expect(checkoutErrorMessage(409, 'slot_held', null)).toMatch(/^Being purchased/);
    expect(checkoutErrorMessage(409, 'already_sponsor')).toMatch(
      /already sponsors this category — ask your rep/,
    );
    expect(checkoutErrorMessage(429, 'hold_limit')).toMatch(/already have a checkout open/);
  });

  it('shows a server sentence but never raw Stripe or validation arrays', () => {
    expect(checkoutErrorMessage(422, "This code isn't valid for this purchase.")).toBe(
      "This code isn't valid for this purchase.",
    );
    expect(checkoutErrorMessage(422, 'stripe: No such coupon')).not.toMatch(/stripe/i);
    expect(checkoutErrorMessage(422, [{ loc: ['body', 'email'] }])).toMatch(/email/);
  });

  it('falls back to a direction, never a mood', () => {
    expect(checkoutErrorMessage(502, 'stripe: boom')).toMatch(/try again/);
    expect(checkoutErrorMessage(undefined, undefined)).toMatch(/try again/);
    expect(checkoutErrorMessage(429, 'Too many checkout attempts — try again soon.')).toMatch(
      /few minutes/,
    );
    expect(checkoutErrorMessage(404, 'Not found')).toMatch(/switched off/);
  });
});

describe('source witnesses', () => {
  const scss = () => readFileSync(join(__dirname, 'ExclusiveCheckout.module.scss'), 'utf8');

  it('the price ticket and slot rows have real rules', () => {
    for (const cls of ['.ticket', '.slotRow', '.slotHeld', '.codeField', '.receipt']) {
      expect(scss()).toMatch(new RegExp(`\\${cls}\\s*\\{[^}]*\\S`));
    }
  });

  it('respects reduced motion', () => {
    expect(scss()).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('never spells the banned HTML5 input types in the new markup', () => {
    for (const f of ['ExclusiveBuy.tsx', 'ExclusiveCheckoutModal.tsx']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/type=["'](url|email|tel)["']/);
    }
  });
});
