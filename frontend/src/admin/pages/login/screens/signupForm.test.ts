import { describe, expect, it } from 'vitest';
import { signupFieldErrors } from './signupForm';

const ok = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  password: 'Analytical1!',
  confirm: 'Analytical1!',
};

describe('signupFieldErrors', () => {
  it('accepts a complete valid form', () => {
    expect(signupFieldErrors(ok)).toEqual({});
  });

  it('requires both names', () => {
    expect(signupFieldErrors({ ...ok, firstName: '  ' }).firstName).toBeTruthy();
    expect(signupFieldErrors({ ...ok, lastName: '' }).lastName).toBeTruthy();
  });

  it('rejects an address with no @', () => {
    expect(signupFieldErrors({ ...ok, email: 'nope' }).email).toBeTruthy();
  });

  it('reports an unmet password policy', () => {
    expect(signupFieldErrors({ ...ok, password: 'short', confirm: 'short' }).password)
      .toBeTruthy();
  });

  it('reports a mismatch on the confirm box, not the password box', () => {
    const errs = signupFieldErrors({ ...ok, confirm: 'Analytical1?' });
    expect(errs.confirm).toBeTruthy();
    expect(errs.password).toBeUndefined();
  });

  it('does not complain about an empty confirm box before it is typed in', () => {
    // A form that opens red is a form that has already annoyed you.
    expect(signupFieldErrors({ ...ok, confirm: '' }).confirm).toBeUndefined();
  });
});
