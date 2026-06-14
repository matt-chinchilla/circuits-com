import { describe, it, expect } from 'vitest';
import { normalizeSponsorTier, SPONSOR_TIER_RANK } from './sponsorTier';

describe('normalizeSponsorTier', () => {
  it('canonicalizes mixed/legacy casing to TitleCase', () => {
    expect(normalizeSponsorTier('platinum')).toBe('Platinum'); // legacy seed
    expect(normalizeSponsorTier('PLATINUM')).toBe('Platinum');
    expect(normalizeSponsorTier('Platinum')).toBe('Platinum');
    expect(normalizeSponsorTier('gold')).toBe('Gold');
    expect(normalizeSponsorTier('Silver')).toBe('Silver');
  });

  it('returns null for dropped/unknown tiers and empty input', () => {
    expect(normalizeSponsorTier('Featured')).toBeNull(); // merged into Platinum, dropped
    expect(normalizeSponsorTier('featured')).toBeNull();
    expect(normalizeSponsorTier('')).toBeNull();
    expect(normalizeSponsorTier(null)).toBeNull();
    expect(normalizeSponsorTier(undefined)).toBeNull();
  });

  it('ranks Platinum > Gold > Silver', () => {
    expect(SPONSOR_TIER_RANK.Platinum).toBeGreaterThan(SPONSOR_TIER_RANK.Gold);
    expect(SPONSOR_TIER_RANK.Gold).toBeGreaterThan(SPONSOR_TIER_RANK.Silver);
  });
});
