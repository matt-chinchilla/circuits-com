import { describe, it, expect } from 'vitest';
import {
  PASSWORD_HELP,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  isPasswordValid,
  unmetKeysFromDetail,
  validatePassword,
  type PasswordRuleKey,
} from '@admin/services/passwordPolicy';

/**
 * Contract test for the frontend mirror of the server password policy.
 *
 * CASES is the shared table: every row is lifted verbatim from the backend's
 * own suite (`api/tests/test_password_policy.py`) — same input string, same
 * expected unmet rule keys, same order. If the two validators ever diverge,
 * one of these rows fails here or there.
 *
 * Non-ASCII inputs are written as \u escapes on purpose: edit tooling mangles
 * raw glyphs in source (see the CLAUDE.md gotcha), and a mangled test input
 * would silently stop testing what it claims to.
 */
const CASES: ReadonlyArray<{ name: string; password: string; unmet: PasswordRuleKey[] }> = [
  // ── valid (test_valid_password_returns_empty_list) ────────────────────────
  { name: 'the canonical valid password', password: 'Abcdef1!gh', unmet: [] },
  { name: 'exactly the minimum length', password: 'Aa1!aaaa', unmet: [] },
  { name: 'exactly the maximum length', password: 'Aa1!aaaaaaaaaaaaaaaaaaaa', unmet: [] },
  { name: 'a space counts as a symbol', password: 'Passw0rd ', unmet: [] },
  { name: 'a unicode symbol counts as a symbol (umbrella)', password: 'Passw0rd\u2602', unmet: [] },
  { name: 'P@ssw0rd', password: 'P@ssw0rd', unmet: [] },

  // ── one rule unmet (test_only_*_unmet) ────────────────────────────────────
  { name: 'too short (7)', password: 'Ab1!cde', unmet: ['length'] },
  { name: 'too long (25)', password: `Ab1!${'c'.repeat(21)}`, unmet: ['length'] },
  { name: 'no uppercase', password: 'abcdef1!gh', unmet: ['uppercase'] },
  { name: 'no digit', password: 'Abcdefg!hi', unmet: ['digit'] },
  { name: 'no symbol', password: 'Abcdef1ghi', unmet: ['symbol'] },

  // ── boundaries 7 / 8 / 24 / 25 (test_length_boundaries) ───────────────────
  { name: 'length 7', password: `Aa1!${'b'.repeat(3)}`, unmet: ['length'] },
  { name: 'length 8', password: `Aa1!${'b'.repeat(4)}`, unmet: [] },
  { name: 'length 24', password: `Aa1!${'b'.repeat(20)}`, unmet: [] },
  { name: 'length 25', password: `Aa1!${'b'.repeat(21)}`, unmet: ['length'] },

  // ── several rules unmet at once ───────────────────────────────────────────
  { name: 'abc', password: 'abc', unmet: ['length', 'uppercase', 'digit', 'symbol'] },
  { name: 'empty', password: '', unmet: ['length', 'uppercase', 'digit', 'symbol'] },
  { name: 'long lowercase', password: 'abcdefghij', unmet: ['uppercase', 'digit', 'symbol'] },

  // ── unicode (ASCII-anchored classes, mirrored on both sides) ──────────────
  { name: 'symbol e-acute', password: 'Passw0rd\u00E9', unmet: [] },
  { name: 'symbol CJK zhong', password: 'Passw0rd\u4E2D', unmet: [] },
  { name: 'symbol right-arrow', password: 'Passw0rd\u2192', unmet: [] },
  { name: 'symbol pound-sign', password: 'Passw0rd\u00A3', unmet: [] },
  {
    // U+00C4 (A-umlaut) is unicode-uppercase but NOT [A-Z] - it counts as a symbol.
    name: 'unicode uppercase does not satisfy the uppercase rule',
    password: '\u00C4bcdef1gh',
    unmet: ['uppercase'],
  },
  {
    // U+0663 (Arabic-Indic three) is a symbol, not [0-9].
    name: 'unicode digit does not satisfy the digit rule',
    password: 'Abcdefg\u0663h',
    unmet: ['digit'],
  },
  {
    name: 'length counts code points, not bytes',
    password: `Aa1!${'\u00E9'.repeat(4)}`, // 8 code points, 12 UTF-8 bytes
    unmet: [],
  },
  {
    // JS-specific guard with no backend twin: 24 code points but 34 UTF-16
    // units. A naive `password.length` would wrongly report `length` unmet and
    // desync this validator from Python's len().
    name: 'astral characters count once (24 code points, 34 UTF-16 units)',
    password: `Aa1!${'b'.repeat(10)}${'\u{1F600}'.repeat(10)}`,
    unmet: [],
  },
];

describe('validatePassword — backend case table', () => {
  it.each(CASES)('$name', ({ password, unmet }) => {
    expect(validatePassword(password)).toEqual(unmet);
  });

  it('never reports a key outside PASSWORD_RULES', () => {
    const keys = new Set(PASSWORD_RULES.map((r) => r.key));
    for (const { password } of CASES) {
      for (const key of validatePassword(password)) {
        expect(keys.has(key)).toBe(true);
      }
    }
  });

  it('treats null and undefined as an empty password', () => {
    expect(validatePassword(null)).toEqual(['length', 'uppercase', 'digit', 'symbol']);
    expect(validatePassword(undefined)).toEqual(['length', 'uppercase', 'digit', 'symbol']);
  });

  it('isPasswordValid agrees with an empty unmet list', () => {
    for (const { password, unmet } of CASES) {
      expect(isPasswordValid(password)).toBe(unmet.length === 0);
    }
  });
});

describe('exported constants mirror the server module', () => {
  it('bounds are 8-24 inclusive', () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([8, 24]);
  });

  it('rules are the four keys in checklist order, each with copy', () => {
    expect(PASSWORD_RULES.map((r) => r.key)).toEqual(['length', 'uppercase', 'digit', 'symbol']);
    for (const rule of PASSWORD_RULES) {
      expect(rule.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('help text is one sentence naming the bounds', () => {
    expect(PASSWORD_HELP).toContain('8-24');
    expect(PASSWORD_HELP.trimEnd().endsWith('.')).toBe(true);
    expect(PASSWORD_HELP).not.toContain('\n');
  });
});

describe('unmetKeysFromDetail', () => {
  it('reads the structured 422 body from /auth/change-password', () => {
    expect(
      unmetKeysFromDetail({
        code: 'password_policy',
        message: PASSWORD_HELP,
        unmet: ['digit', 'length'],
      }),
    ).toEqual(['length', 'digit']); // normalized back to checklist order
  });

  it('drops keys it has no copy for', () => {
    expect(unmetKeysFromDetail({ unmet: ['pwned', 'symbol'] })).toEqual(['symbol']);
  });

  it('returns [] for every other shape', () => {
    expect(unmetKeysFromDetail(undefined)).toEqual([]);
    expect(unmetKeysFromDetail(null)).toEqual([]);
    expect(unmetKeysFromDetail('Current password is incorrect.')).toEqual([]);
    expect(unmetKeysFromDetail({ unmet: 'length' })).toEqual([]);
    expect(unmetKeysFromDetail([{ loc: ['body'], msg: 'field required' }])).toEqual([]);
  });
});
