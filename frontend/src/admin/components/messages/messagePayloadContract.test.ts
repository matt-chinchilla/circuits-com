// The signup/welcome payloads have TWO homes: the dict POST /api/auth/verify
// writes into `messages.payload`, and the TypeScript interfaces the inbox
// reads it back through. `payload` is an untyped JSON column on both sides —
// no schema, no Pydantic model, no 422 — so a renamed key on the writer would
// surface only as a blank field in the admin, months later.
//
// This pins them together the way the password policy's two homes are pinned:
// edit one and the other's key list is your reminder.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AUTH_ROUTE = join(__dirname, '../../../../../api/app/routes/auth.py');
const TYPES = join(__dirname, '../../types/messages.ts');

/** Keys of the `payload={...}` dict the verify route writes for one row type. */
function backendPayloadKeys(source: string, messageType: string): string[] {
  const arm = source.split(`type="${messageType}"`)[1];
  expect(arm, `no Message(type="${messageType}") in routes/auth.py`).toBeDefined();
  const dict = arm.split('payload={')[1]?.split('}')[0];
  expect(dict, `no payload={...} after type="${messageType}"`).toBeDefined();
  return [...dict.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
}

/** Field names declared on one exported interface in the admin types file. */
function interfaceFields(source: string, name: string): string[] {
  const body = source.split(`export interface ${name} {`)[1]?.split('}')[0];
  expect(body, `no interface ${name} in types/messages.ts`).toBeDefined();
  return [...body.matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]);
}

describe('the signup/welcome payloads match what the backend writes', () => {
  const py = readFileSync(AUTH_ROUTE, 'utf8');
  const ts = readFileSync(TYPES, 'utf8');

  it('SignupPayload declares exactly the staff row keys the backend writes', () => {
    expect(interfaceFields(ts, 'SignupPayload').sort()).toEqual(
      backendPayloadKeys(py, 'signup').sort(),
    );
  });

  it('WelcomePayload declares exactly the customer row keys the backend writes', () => {
    expect(interfaceFields(ts, 'WelcomePayload').sort()).toEqual(
      backendPayloadKeys(py, 'welcome').sort(),
    );
  });

  it('reads a real writer, not an empty string', () => {
    // If the route ever stops writing these rows this file must fail loudly
    // rather than compare two empty lists and pass.
    expect(backendPayloadKeys(py, 'signup').length).toBeGreaterThan(1);
    expect(backendPayloadKeys(py, 'welcome').length).toBeGreaterThan(1);
  });
});
