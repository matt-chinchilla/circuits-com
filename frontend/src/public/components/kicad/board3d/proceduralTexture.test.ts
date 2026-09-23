// The surface texels the 3D bodies and pins are finished with (spec 2026-09-22
// realistic parts §1.4): generated, never downloaded, and the same bytes every
// time, so a board looks the same on every visit and a test can pin it.
import { describe, expect, it } from 'vitest';
import { BRUSHED, GRAIN, surfaceTexels, valueNoise, type NoiseSpec } from './proceduralTexture';

/** Mean |difference| between neighbours along x and along y, the wrap seam
 *  (last column against the first, last row against the first) apart. */
function roughness(field: Float32Array, size: number) {
  let dx = 0, dy = 0, seamX = 0, seamY = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = field[y * size + x];
      const right = field[y * size + ((x + 1) % size)];
      const down = field[((y + 1) % size) * size + x];
      if (x === size - 1) seamX += Math.abs(v - right); else dx += Math.abs(v - right);
      if (y === size - 1) seamY += Math.abs(v - down); else dy += Math.abs(v - down);
    }
  }
  return { dx: dx / (size * (size - 1)), dy: dy / (size * (size - 1)), seamX: seamX / size, seamY: seamY / size };
}

describe('valueNoise', () => {
  it('is deterministic: the same spec gives the same field, another seed another one', () => {
    const a = valueNoise(GRAIN), b = valueNoise(GRAIN);
    expect(a).toEqual(b);
    const c = valueNoise({ ...GRAIN, seed: GRAIN.seed + 1 });
    expect(c).not.toEqual(a);
  });

  it('fills [0, 1] exactly, one value per texel', () => {
    for (const spec of [GRAIN, BRUSHED]) {
      const f = valueNoise(spec);
      expect(f.length).toBe(spec.size * spec.size);
      let lo = Infinity, hi = -Infinity;
      for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      expect(lo).toBe(0);
      expect(hi).toBe(1);
    }
  });

  it('tiles: the wrap seam is no rougher than any other neighbour pair', () => {
    for (const spec of [GRAIN, BRUSHED]) {
      const r = roughness(valueNoise(spec), spec.size);
      expect(r.seamX).toBeLessThan(r.dx * 2.5 + 1e-6);
      expect(r.seamY).toBeLessThan(r.dy * 2.5 + 1e-6);
    }
  });

  it('the grain is isotropic; the brushed finish streaks along x', () => {
    const g = roughness(valueNoise(GRAIN), GRAIN.size);
    expect(g.dx / g.dy).toBeGreaterThan(0.6);
    expect(g.dx / g.dy).toBeLessThan(1.6);
    const b = roughness(valueNoise(BRUSHED), BRUSHED.size);
    expect(b.dx / b.dy).toBeLessThan(0.25);
  });

  it('refuses a lattice that cannot tile the texture', () => {
    const bad: NoiseSpec = { ...GRAIN, cellX: 3 };
    expect(() => valueNoise(bad)).toThrow();
    expect(() => valueNoise({ ...GRAIN, size: 200 })).toThrow();
  });
});

describe('surfaceTexels', () => {
  it('packs height into red and blue, a roughness multiplier into green, alpha opaque', () => {
    const t = surfaceTexels(GRAIN);
    expect(t.length).toBe(GRAIN.size * GRAIN.size * 4);
    let rLo = 255, rHi = 0, gLo = 255, gHi = 0, blueMatches = true, opaque = true;
    for (let i = 0; i < t.length; i += 4) {
      rLo = Math.min(rLo, t[i]); rHi = Math.max(rHi, t[i]);
      gLo = Math.min(gLo, t[i + 1]); gHi = Math.max(gHi, t[i + 1]);
      if (t[i + 2] !== t[i]) blueMatches = false;
      if (t[i + 3] !== 255) opaque = false;
    }
    expect(blueMatches).toBe(true);
    expect(opaque).toBe(true);
    expect(rLo).toBe(0);
    expect(rHi).toBe(255);
    // The multiplier never takes a surface below its floor: a map varies the
    // finish, it does not turn epoxy into a mirror.
    expect(gLo).toBe(Math.round(GRAIN.roughnessFloor * 255));
    expect(gHi).toBe(255);
  });

  it('is the same bytes every call', () => {
    expect(surfaceTexels(BRUSHED)).toEqual(surfaceTexels(BRUSHED));
  });
});
