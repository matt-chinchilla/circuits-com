// Pure field validation for the Sign Up screen.
//
// Kept out of the component so the rules can be tested without a DOM — the
// harness is unit-logic only (`*.test.ts`, environment `node`).
import { isPasswordValid } from '@admin/services/passwordPolicy';
import { isEmail } from '../lib/recovery';

export interface SignupFields {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirm: string;
}

export type SignupErrors = Partial<Record<keyof SignupFields, string>>;

export function signupFieldErrors(fields: SignupFields): SignupErrors {
  const errors: SignupErrors = {};
  if (!fields.firstName.trim()) errors.firstName = 'Enter your first name.';
  if (!fields.lastName.trim()) errors.lastName = 'Enter your last name.';
  // `isEmail` from ../lib/recovery is the folder's ONE address check (sign-in
  // and password recovery already read it), so the three auth screens cannot
  // disagree about what an address looks like. The form itself is
  // `type="text"` + inputMode="email" on a noValidate form, never
  // type="email": an HTML5-invalid value silently kills submit, with no
  // console error and no :invalid styling.
  if (!isEmail(fields.email)) errors.email = 'Enter a valid email address.';
  // The live checklist under the field says WHICH rule is unmet; this message
  // only has to point at the box, so it deliberately doesn't restate them.
  if (!isPasswordValid(fields.password)) {
    errors.password = 'Password does not meet the rules below.';
  }
  // Only complain once they have started typing — an empty confirm box is a
  // form that is not finished, not a form that is wrong. The submit handler
  // re-checks equality, so an untouched box can never slip through.
  if (fields.confirm.length > 0 && fields.confirm !== fields.password) {
    errors.confirm = 'Passwords do not match.';
  }
  return errors;
}
