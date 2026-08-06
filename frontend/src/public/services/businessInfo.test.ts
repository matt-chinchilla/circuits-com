import { describe, expect, it } from 'vitest';
import {
  DOC_DATES,
  DOC_VERSIONS,
  FABRICATED_ADDRESS_FRAGMENTS,
  formatDocDate,
  formatMailingAddress,
  noticeClause,
} from './businessInfo';

/**
 * These guard two mistakes that shipped to production once each, both in the
 * published privacy policy, and both invisible in review because the output
 * looked entirely plausible.
 */

describe('mailing address', () => {
  it('never renders a fabricated placeholder address', () => {
    // "1 Industry Park Way, Brookhaven, NY 11719" came from a design mockup and
    // sat in the notice clause of the live policy for months. It reads as a real
    // address to anyone trying to serve a notice there.
    const rendered = formatMailingAddress();
    if (rendered === null) return;
    for (const fragment of FABRICATED_ADDRESS_FRAGMENTS) {
      expect(rendered).not.toContain(fragment);
    }
  });

  it('omits the postal route entirely rather than inventing one', () => {
    const clause = noticeClause('legal@circuitcenter.ai');
    expect(clause).toContain('legal@circuitcenter.ai');
    if (formatMailingAddress() === null) {
      expect(clause).not.toContain('by mail');
    }
  });
});

describe('document dates', () => {
  it('formats a pinned date rather than the current one', () => {
    // The prior implementation formatted new Date(), so every document claimed
    // an effective date of whichever day you loaded it — and the prerendered
    // HTML froze whatever day the site was last built.
    expect(formatDocDate('2026-08-05')).toBe('August 5, 2026');
  });

  it('does not drift across timezones', () => {
    // Parsed as UTC. A local-time parse renders the previous day west of
    // Greenwich, which would date a document one day before it took effect.
    expect(formatDocDate('2026-01-01')).toBe('January 1, 2026');
    expect(formatDocDate('2026-12-31')).toBe('December 31, 2026');
  });

  it('pins a date and a version for every document', () => {
    expect(Object.keys(DOC_DATES).sort()).toEqual(Object.keys(DOC_VERSIONS).sort());
    for (const iso of Object.values(DOC_DATES)) {
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
