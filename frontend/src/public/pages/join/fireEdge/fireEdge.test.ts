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
  const SHA256 = 'd80d76e684e0ad81f9dc9c7e93e567d1914962f70e6567da4037346276e17fbb';
  const BYTES = 22357;

  it('is byte-for-byte the owner’s export', () => {
    const buf = readFileSync(VENDOR);
    expect(createHash('sha256').update(buf).digest('hex')).toBe(SHA256);
    expect(buf.byteLength).toBe(BYTES);
    const provenance = readFileSync(join(__dirname, 'PROVENANCE.md'), 'utf8');
    expect(provenance).toContain(SHA256);
    expect(provenance).toContain('22,357 bytes');
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
