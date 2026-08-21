// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAP_MEMORY_KEY,
  MAX_REMEMBERED_SIGNATURES,
  loadRoleMap,
  saveRoleMap,
} from './mapMemory';
import type { BomRole } from './headerAliases';

const ROLES: (BomRole | null)[] = ['refs', 'qty', 'mpn', null];

describe('mapMemory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a role map by signature', () => {
    saveRoleMap('refs|qty|mpn|price', ROLES);
    expect(loadRoleMap('refs|qty|mpn|price')).toEqual(ROLES);
  });

  it('returns null for a signature it has never seen', () => {
    saveRoleMap('refs|qty', ['refs', 'qty']);
    expect(loadRoleMap('designator|quantity')).toBeNull();
  });

  it('returns null for corrupted JSON instead of throwing', () => {
    localStorage.setItem(MAP_MEMORY_KEY, '{not json');
    expect(() => loadRoleMap('refs|qty')).not.toThrow();
    expect(loadRoleMap('refs|qty')).toBeNull();
  });

  it('returns null when a stored entry is the wrong shape', () => {
    localStorage.setItem(MAP_MEMORY_KEY, JSON.stringify({ 'refs|qty': { roles: 'mpn' } }));
    expect(loadRoleMap('refs|qty')).toBeNull();
  });

  it('drops a role string it does not recognize', () => {
    localStorage.setItem(
      MAP_MEMORY_KEY,
      JSON.stringify({ 'refs|qty': { roles: ['refs', 'nonsense'], savedAt: 1 } }),
    );
    expect(loadRoleMap('refs|qty')).toEqual(['refs', null]);
  });

  it('evicts the oldest signature when the 21st is saved', () => {
    for (let i = 0; i < MAX_REMEMBERED_SIGNATURES; i += 1) {
      saveRoleMap(`sig-${i}`, ['mpn']);
    }
    expect(loadRoleMap('sig-0')).toEqual(['mpn']);

    saveRoleMap('sig-new', ['qty']);

    expect(loadRoleMap('sig-0')).toBeNull();
    expect(loadRoleMap('sig-new')).toEqual(['qty']);
    expect(
      Object.keys(JSON.parse(localStorage.getItem(MAP_MEMORY_KEY) ?? '{}')),
    ).toHaveLength(MAX_REMEMBERED_SIGNATURES);
  });

  it('re-saving an existing signature refreshes it rather than adding a second', () => {
    saveRoleMap('refs|qty', ['refs', 'qty']);
    saveRoleMap('refs|qty', ['mpn', 'qty']);
    expect(loadRoleMap('refs|qty')).toEqual(['mpn', 'qty']);
    expect(
      Object.keys(JSON.parse(localStorage.getItem(MAP_MEMORY_KEY) ?? '{}')),
    ).toHaveLength(1);
  });
});
