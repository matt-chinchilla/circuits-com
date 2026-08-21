import { describe, expect, it } from 'vitest';

import { parseServerTime, relativeTime } from './time';

const NOW = Date.parse('2026-08-20T12:00:00Z');

describe('parseServerTime', () => {
  it('treats offset-less strings as UTC', () => {
    expect(parseServerTime('2026-08-20T12:00:00')).toBe(NOW);
    expect(parseServerTime('2026-08-20T12:00:00Z')).toBe(NOW);
    expect(parseServerTime('2026-08-20T14:00:00+02:00')).toBe(NOW);
  });
});

describe('relativeTime', () => {
  it('bands', () => {
    expect(relativeTime('2026-08-20T11:59:30Z', NOW)).toBe('just now');
    expect(relativeTime('2026-08-20T11:15:00Z', NOW)).toBe('45m ago');
    expect(relativeTime('2026-08-20T05:00:00Z', NOW)).toBe('7h ago');
    expect(relativeTime('2026-08-17T12:00:00Z', NOW)).toBe('3d ago');
    expect(relativeTime('2026-07-25T12:00:00Z', NOW)).toBe('3w ago');
    expect(relativeTime('2026-05-20T12:00:00Z', NOW)).toBe('3mo ago');
    expect(relativeTime('2024-01-01T00:00:00Z', NOW)).toBe('2y ago');
  });

  it('null-safe and unparseable-safe', () => {
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime('garbage', NOW)).toBeNull();
  });
});
