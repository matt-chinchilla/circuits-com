/**
 * `<fire-edge>` — the vendored design file behind the Join page's Founder's
 * Discount burn.
 *
 * These are integrity tests, not behaviour tests: the artwork is the owner's,
 * and the only thing this repo promises about it is that the bytes are still
 * the export. The design-import folder is gitignored, so a clean checkout can
 * check the sha256 recorded in PROVENANCE.md but never a `cmp` — hence the hash
 * here rather than a file comparison. Same shape as the `fire-badge` block in
 * `@shared/components/FounderBadge/founderBadge.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the vendored design file', () => {
  const VENDOR = join(__dirname, 'fire-edge.vendor.js');
  // Recorded in PROVENANCE.md. Re-export the design, do not edit the file: if
  // this fails, either the bytes drifted or the hash + PROVENANCE.md were not
  // updated together.
  const SHA256 = 'eee25869d6d574e2a235f2c435de97264c287a520947c09a987ee42b5653b6e5';
  const BYTES = 22161;

  it('is the owner’s export plus the two documented patches', () => {
    const buf = readFileSync(VENDOR);
    expect(createHash('sha256').update(buf).digest('hex')).toBe(SHA256);
    expect(buf.byteLength).toBe(BYTES);
    const provenance = readFileSync(join(__dirname, 'PROVENANCE.md'), 'utf8');
    expect(provenance).toContain(SHA256);
    expect(provenance).toContain('22,161 bytes');
  });

  it('keeps the reduced-motion gate and drops only the ≤768px one (patch 1)', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(src).toContain('if (reduced.matches) return; /* PATCHED');
    expect(src).not.toContain('reduced.matches || mobile.matches');
  });

  // Patch 2 (2026-09-24, performance only — PROVENANCE.md has the numbers and
  // the seeded pixel-parity proof). These pin the two changes so a re-export
  // that silently drops them shows up here, not as lag on the Join page.
  it('draws the coal bed straight onto its own canvas — no offscreen layer (patch 2)', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(src).toContain('if (this._coals) { this._drawCoals(ctx, eu, t, o); this._coalAt = t; } /* PATCHED');
    // the per-frame offscreen canvas, its flush and its blit are gone
    expect(src).not.toContain('this._cc.getContext');
    expect(src).not.toContain('drawImage(this._cc');
    expect(src).not.toContain('if (true)');
  });

  it('reuses one vertex buffer per coal outline instead of allocating per frame (patch 2)', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(src).not.toContain('c.verts.map(([vx, vy]) =>');
    expect(src).toContain('P[i][0] = cx + (ux * vx + nx * vy) * S; P[i][1] = cy + (uy * vx + ny * vy) * S; } /* PATCHED');
  });

  it('marks exactly the three patched places', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(src.match(/\/\* PATCHED/g)).toHaveLength(3);
  });

  it('registers the element, and is safe to side-effect-import more than once', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(src).toContain("customElements.define('fire-edge'");
    expect(src).toContain("if (customElements.get('fire-edge')) return;");
  });

  it('needs no asset patch — it never reads document.currentScript', () => {
    // glow-badge did (its dot-grid texture); this file draws every sprite into
    // an offscreen canvas, so it is vendored unpatched. PROVENANCE.md says so.
    expect(readFileSync(VENDOR, 'utf8')).not.toContain('document.currentScript');
  });
});
