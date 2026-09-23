import { describe, expect, it } from 'vitest';
import { apiErrorDetail } from './apiError';

// axios.isAxiosError only checks the `isAxiosError` flag, so a plain object
// stands in for a rejected request.
function httpError(status: number, detail: unknown) {
  return { isAxiosError: true, response: { status, data: { detail } } };
}

const SALES_CODES = [
  'no_billing_access',
  'billing_active',
  'legacy_price',
  'ambiguous_subscription',
  'unsupported_payment',
  'already_sponsor',
  'idempotency_key_required',
  'hold_limit',
];

describe('apiErrorDetail — sales + billing machine codes', () => {
  it.each(SALES_CODES)('turns %s into a sentence', (code) => {
    const text = apiErrorDetail(httpError(409, code));
    expect(text).toBeTruthy();
    expect(text).not.toBe(code);
    expect(text).not.toMatch(/_/);
    // A sentence, not a label.
    expect(text!.length).toBeGreaterThan(20);
  });

  it('keeps human-written details as they are', () => {
    expect(apiErrorDetail(httpError(422, "This code isn't valid for this purchase."))).toBe(
      "This code isn't valid for this purchase.",
    );
  });

  it('still surfaces nothing for a validation array or a network failure', () => {
    expect(apiErrorDetail(httpError(422, [{ loc: ['body'], msg: 'bad' }]))).toBeUndefined();
    expect(apiErrorDetail({ isAxiosError: true })).toBeUndefined();
    expect(apiErrorDetail(new Error('boom'))).toBeUndefined();
  });
});
