import { describe, it, expect } from 'vitest';
import type { AdminSponsor } from '@admin/types/admin';
import {
  countActiveSponsorsByTier,
  isActiveSponsor,
  normalizeSponsorTier,
  SPONSOR_TIER_RANK,
} from './sponsorTier';

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

describe('isActiveSponsor', () => {
  it('treats Active and null as active; Paused/Expired as inactive', () => {
    expect(isActiveSponsor('Active')).toBe(true);
    expect(isActiveSponsor(null)).toBe(true);
    expect(isActiveSponsor(undefined)).toBe(true);
    expect(isActiveSponsor('Paused')).toBe(false);
    expect(isActiveSponsor('Expired')).toBe(false);
  });
});

describe('countActiveSponsorsByTier', () => {
  const row = (tier: string, status: string | null): AdminSponsor =>
    ({ tier, status }) as unknown as AdminSponsor;

  it('counts active sponsors by normalized tier, ignoring inactive + dropped', () => {
    const counts = countActiveSponsorsByTier([
      row('platinum', null), // lowercase legacy, active
      row('Platinum', 'Active'),
      row('Gold', null),
      row('silver', 'Active'),
      row('Gold', 'Paused'), // inactive -> ignored
      row('Featured', null), // dropped tier -> ignored
    ]);
    expect(counts).toEqual({ Platinum: 2, Gold: 1, Silver: 1 });
  });
});
