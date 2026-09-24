import { describe, expect, it } from 'vitest';

import { formatEasternDate, provenanceLine } from './provenance';

describe('formatEasternDate', () => {
  it('uses the Eastern calendar day, not UTC', () => {
    // 02:30 UTC on the 24th is still the evening of the 23rd in New York.
    expect(formatEasternDate('2026-09-24T02:30:00+00:00')).toBe('Sep 23, 2026');
    expect(formatEasternDate('2026-09-24T14:00:00Z')).toBe('Sep 24, 2026');
  });

  it('reads an offset-less timestamp as UTC', () => {
    expect(formatEasternDate('2026-09-24T02:30:00')).toBe('Sep 23, 2026');
  });

  it('returns null for nothing usable', () => {
    expect(formatEasternDate(null)).toBeNull();
    expect(formatEasternDate(undefined)).toBeNull();
    expect(formatEasternDate('not a date')).toBeNull();
  });
});

describe('provenanceLine', () => {
  it('names the rep and the day', () => {
    expect(provenanceLine('Daniel', '2026-09-23T15:00:00Z')).toBe('Added by Daniel · Sep 23, 2026');
  });

  it('says "you" to the rep who added it', () => {
    expect(provenanceLine('Daniel', '2026-09-23T15:00:00Z', 'Daniel')).toBe('Added by you · Sep 23, 2026');
  });

  it('credits the roster import when nobody is recorded', () => {
    expect(provenanceLine(null, '2026-08-20T15:00:00Z')).toBe('From the roster import');
  });

  it('says nothing when the payload predates the field', () => {
    expect(provenanceLine(undefined, undefined)).toBeNull();
  });

  it('drops an unreadable date rather than print it', () => {
    expect(provenanceLine('Ronald', null)).toBe('Added by Ronald');
  });
});
