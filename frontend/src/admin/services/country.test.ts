import { describe, expect, it } from 'vitest';

import { countryName, flagEmoji } from './country';

// countryName wraps Intl.DisplayNames, which THROWS on a malformed region
// rather than returning a fallback — the try/catch is the whole reason this
// helper exists, so the contract pinned here is "never throw, always render
// something the operator can read".
describe('countryName', () => {
  it('renders a readable name for a real alpha-2 code', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('DE')).toBe('Germany');
  });

  it('falls back to the code itself when Intl has no name for it', () => {
    // QQ is unassigned in CLDR, so Intl hands the code straight back.
    // (ZZ is NOT the test to write here — CLDR names it "Unknown Region".)
    expect(countryName('QQ')).toBe('QQ');
  });

  it('never throws on garbage input', () => {
    // A structurally invalid region throws RangeError inside Intl.
    expect(() => countryName('')).not.toThrow();
    expect(countryName('')).toBe('');
    expect(() => countryName('not-a-region')).not.toThrow();
  });
});

describe('flagEmoji', () => {
  it('maps alpha-2 to regional indicators, case-insensitively', () => {
    expect(flagEmoji('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(flagEmoji('de')).toBe('\u{1F1E9}\u{1F1EA}');
  });

  it('renders nothing for anything that is not two letters', () => {
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('USA')).toBe('');
    expect(flagEmoji('1x')).toBe('');
  });
});
