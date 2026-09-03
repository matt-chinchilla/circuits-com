import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import {
  NO_LEADS_ACCESS_DETAIL,
  SESSION_EXPIRED_MESSAGE,
  classifyLeadsError,
} from './loadError';

const FALLBACK = 'Failed to load leads.';

/** An axios error shaped exactly like the ones adminApi rejects with. */
function axiosErr(status: number, detail?: unknown): AxiosError {
  const err = new AxiosError('Request failed');
  const headers = new AxiosHeaders();
  err.response = {
    status,
    statusText: '',
    headers,
    config: { headers },
    data: detail === undefined ? {} : { detail },
  } as AxiosError['response'];
  return err;
}

describe('classifyLeadsError', () => {
  it('recognises the demo refusal by its exact detail', () => {
    expect(classifyLeadsError(axiosErr(403, NO_LEADS_ACCESS_DETAIL), FALLBACK).kind).toBe('demo');
  });

  it('does not treat any other 403 as the demo refusal', () => {
    const res = classifyLeadsError(axiosErr(403, 'password_change_required'), FALLBACK);
    expect(res.kind).toBe('failed');
    // The machine code must NEVER reach the screen.
    expect(res.message).toBe(FALLBACK);
  });

  // THE BUG: FastAPI's internal auth prose was printed at the owner.
  it.each([
    'Not authenticated',
    'Token expired',
    'Session expired',
    'Invalid token',
    'User not found',
    undefined,
  ])('maps a 401 (detail %s) to the named session sentence', (detail) => {
    const res = classifyLeadsError(axiosErr(401, detail), FALLBACK);
    expect(res.kind).toBe('session');
    expect(res.message).toBe(SESSION_EXPIRED_MESSAGE);
    if (typeof detail === 'string') expect(res.message).not.toContain(detail);
  });

  it('surfaces human-written server copy for 400/409/422 string details', () => {
    for (const status of [400, 409, 422]) {
      const res = classifyLeadsError(axiosErr(status, 'That outcome is not a valid choice.'), FALLBACK);
      expect(res.kind).toBe('failed');
      expect(res.message).toBe('That outcome is not a valid choice.');
    }
  });

  it('falls back rather than rendering a 422 detail ARRAY', () => {
    const res = classifyLeadsError(axiosErr(422, [{ loc: ['body'], msg: 'nope' }]), FALLBACK);
    expect(res.kind).toBe('failed');
    expect(res.message).toBe(FALLBACK);
  });

  it('never leaks a 500 body', () => {
    const res = classifyLeadsError(axiosErr(500, 'Traceback: psycopg2.OperationalError'), FALLBACK);
    expect(res.kind).toBe('failed');
    expect(res.message).toBe(FALLBACK);
  });

  it('handles a network failure (no response) and a non-axios throw', () => {
    expect(classifyLeadsError(new AxiosError('Network Error'), FALLBACK)).toEqual({
      kind: 'failed',
      message: FALLBACK,
    });
    expect(classifyLeadsError(new Error('boom'), FALLBACK)).toEqual({
      kind: 'failed',
      message: FALLBACK,
    });
  });

  it('still maps the demo-write refusal through the shared code table', () => {
    const res = classifyLeadsError(axiosErr(403, 'demo_account_read_only'), FALLBACK);
    expect(res.kind).toBe('failed');
    expect(res.message).not.toBe('demo_account_read_only');
  });
});
