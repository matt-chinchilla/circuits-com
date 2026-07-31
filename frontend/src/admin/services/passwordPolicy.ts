/**
 * Admin password policy — the FRONTEND mirror of `app/services/password_policy.py`.
 *
 * This is the ONE frontend home for the four rules. The live checklist on the
 * forced "Set a new password" screen, any client-side pre-validation, and the
 * help sentence all read from here, so the UI and the API's 422 body can never
 * disagree about what a valid password is.
 *
 * The policy is EXACTLY:
 *
 *     length     8-24 characters, inclusive
 *     uppercase  at least one uppercase letter
 *     digit      at least one number
 *     symbol     at least one symbol (any non-alphanumeric character)
 *
 * Character classes are ASCII-anchored (`[A-Z]`, `[0-9]`, `[^A-Za-z0-9]`) to
 * match the Python side byte-for-byte — the backend deliberately avoids
 * unicode-aware `str.isupper()`/`str.isdigit()` for exactly this reason. Note
 * the direction of the looseness: non-ASCII characters are NOT rejected, they
 * simply count as *symbols* (`☂`, `é` and `中` all satisfy the symbol rule).
 *
 * Length counts CODE POINTS (`[...value].length`), not UTF-16 units, so an
 * astral character (emoji) counts once here and once in Python.
 *
 * Contract test: `passwordPolicy.test.ts` replays the backend's own case table
 * (api/tests/test_password_policy.py) against `validatePassword`.
 */

// Inclusive bounds — never re-hardcode these numbers at a call site.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 24;

/** The four rule keys the API speaks in its 422 `detail.unmet` array. */
export type PasswordRuleKey = 'length' | 'uppercase' | 'digit' | 'symbol';

export interface PasswordRule {
  key: PasswordRuleKey;
  /** Checklist copy. Mirrors PASSWORD_RULES in password_policy.py. */
  label: string;
}

/** Ordered — this IS the display order of the checklist and of unmet keys. */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  { key: 'length', label: `Between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters` },
  { key: 'uppercase', label: 'At least one uppercase letter' },
  { key: 'digit', label: 'At least one number' },
  { key: 'symbol', label: 'At least one symbol (anything that is not a letter or number)' },
];

/** One human sentence for form hints — mirrors PASSWORD_HELP server-side. */
export const PASSWORD_HELP =
  `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and include ` +
  'at least one uppercase letter, one number, and one symbol.';

const UPPERCASE_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
const SYMBOL_RE = /[^A-Za-z0-9]/;

const RULE_KEYS: readonly PasswordRuleKey[] = PASSWORD_RULES.map((r) => r.key);

/**
 * Return the keys of the rules the password FAILS, in PASSWORD_RULES order.
 * An empty array means valid. Every unmet key is reported (not just the first)
 * so one call ticks the whole checklist.
 *
 * `null`/`undefined` are treated as an empty password (every rule unmet) —
 * `?:` catches undefined but NOT null, so both are handled explicitly.
 */
export function validatePassword(password: string | null | undefined): PasswordRuleKey[] {
  const value = password ?? '';
  const unmet: PasswordRuleKey[] = [];
  // Code points, not UTF-16 units — see the module header.
  const length = [...value].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) unmet.push('length');
  if (!UPPERCASE_RE.test(value)) unmet.push('uppercase');
  if (!DIGIT_RE.test(value)) unmet.push('digit');
  if (!SYMBOL_RE.test(value)) unmet.push('symbol');
  return unmet;
}

/** Convenience: does this password satisfy all four rules? */
export const isPasswordValid = (password: string | null | undefined): boolean =>
  validatePassword(password).length === 0;

/**
 * Read the rule keys out of an API error body.
 *
 * `POST /api/auth/change-password` answers a policy violation with a
 * STRUCTURED 422 detail — `{ code: 'password_policy', message, unmet: [...] }`
 * — which `apiErrorDetail` deliberately drops (it only surfaces string
 * details, since a stock FastAPI 422 detail is an array that would crash as a
 * React child). This pulls the checklist keys back out.
 *
 * Returns `[]` for any other shape, so a caller can safely fall back to its own
 * client-side `validatePassword` result. Unknown keys are discarded rather than
 * rendered — the checklist can only show rules it has copy for.
 */
export function unmetKeysFromDetail(detail: unknown): PasswordRuleKey[] {
  if (typeof detail !== 'object' || detail === null) return [];
  const unmet = (detail as { unmet?: unknown }).unmet;
  if (!Array.isArray(unmet)) return [];
  return RULE_KEYS.filter((key) => unmet.includes(key));
}
