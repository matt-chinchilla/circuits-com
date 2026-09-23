// The surface the 3D bodies and pins are finished with (spec 2026-09-22 realistic
// parts §1.4): value noise, generated in the page, no asset file and no network.
//
// Two finishes. GRAIN is moulded epoxy — a fine, even speckle that breaks a
// package's highlight into the satin sheen a real chip has, rather than the
// plastic-toy sheen of a flat colour. BRUSHED is plated metal — long streaks along
// one axis, the tell of a stamped and tin- or gold-plated lead.
//
// Pure and deterministic: the same spec gives the same bytes every time (a fixed
// seed and an integer hash, no Math.random), so a board looks the same on every
// visit and a test can pin it. The renderer turns the bytes into ONE texture per
// finish per mount and releases it with the rest.

export interface NoiseSpec {
  /** Texels per side; a power of two so the GPU can mipmap and repeat it. */
  size: number;
  seed: number;
  /** Lattice cell of the first octave in texels, along x and along y. Each must
   *  divide `size`, or the lattice would not wrap and the texture would seam. */
  cellX: number;
  cellY: number;
  /** Each octave halves both cells (never below one texel) at half the weight. */
  octaves: number;
  /** The lowest roughness MULTIPLIER the map applies (green channel, 0..1): the
   *  finish varies between this share of the material's roughness and all of it. */
  roughnessFloor: number;
}

/** Moulded epoxy: isotropic, fine. Four octaves from 32-texel cells down to 4. */
export const GRAIN: NoiseSpec = { size: 256, seed: 0x5eed1, cellX: 32, cellY: 32, octaves: 4, roughnessFloor: 0.72 };

/** Brushed plating: cells 64 texels long in x and 2 across in y, so the streaks
 *  run along x (the texture's u), three octaves. */
export const BRUSHED: NoiseSpec = { size: 256, seed: 0xb0551, cellX: 64, cellY: 2, octaves: 3, roughnessFloor: 0.6 };

/** A 32-bit integer hash of a lattice point (lowbias32 over the mixed inputs),
 *  as a value in [0, 1). */
function hash(x: number, y: number, octave: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(octave + 1, 0x9e3779b1) ^ seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * `spec.size`² values in [0, 1], row-major, that TILE: the lattice indices wrap
 * at the texture edge, so the last column blends into the first exactly as any
 * two neighbours do. Normalised to the full range, so every finish has the same
 * contrast and the material decides how much of it shows.
 */
export function valueNoise(spec: NoiseSpec): Float32Array {
  const { size, seed, octaves } = spec;
  if (size <= 0 || (size & (size - 1)) !== 0) throw new Error(`noise size ${size} is not a power of two`);
  const out = new Float32Array(size * size);
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    const cx = Math.max(1, spec.cellX >> o), cy = Math.max(1, spec.cellY >> o);
    if (size % cx !== 0 || size % cy !== 0) throw new Error(`noise cell ${cx}x${cy} does not tile ${size}`);
    const nx = size / cx, ny = size / cy;
    // This octave's lattice, once: nx × ny values.
    const lattice = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) lattice[j * nx + i] = hash(i, j, o, seed);
    for (let y = 0; y < size; y++) {
      const gy = y / cy, j0 = Math.floor(gy), ty = smooth(gy - j0);
      const r0 = (j0 % ny) * nx, r1 = ((j0 + 1) % ny) * nx;
      for (let x = 0; x < size; x++) {
        const gx = x / cx, i0 = Math.floor(gx), tx = smooth(gx - i0);
        const a = i0 % nx, b = (i0 + 1) % nx;
        const top = lattice[r0 + a] + (lattice[r0 + b] - lattice[r0 + a]) * tx;
        const bottom = lattice[r1 + a] + (lattice[r1 + b] - lattice[r1 + a]) * tx;
        out[y * size + x] += weight * (top + (bottom - top) * ty);
      }
    }
    weight *= 0.5;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
  return out;
}

/**
 * The finish as RGBA bytes, ready for a texture: red (and blue) is the HEIGHT
 * a bump map reads, full range; green is the ROUGHNESS multiplier a roughness
 * map reads, from `roughnessFloor` up to 1. One texture serves both maps,
 * because three reads the bump from red and the roughness from green.
 */
export function surfaceTexels(spec: NoiseSpec): Uint8Array {
  const field = valueNoise(spec);
  const out = new Uint8Array(field.length * 4);
  const floor = spec.roughnessFloor;
  for (let i = 0; i < field.length; i++) {
    const h = Math.round(field[i] * 255);
    out[i * 4] = h;
    out[i * 4 + 1] = Math.round((floor + (1 - floor) * field[i]) * 255);
    out[i * 4 + 2] = h;
    out[i * 4 + 3] = 255;
  }
  return out;
}
