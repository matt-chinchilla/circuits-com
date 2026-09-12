// frontend/src/public/components/kicad/vendorIntegrity.test.ts
// The fast local echo of the check build-kicanvas.mjs runs on every image
// build: the vendored KiCanvas tree matches its manifest, carries the pinned
// commit, and references no web-font host (spec §5.1).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VENDOR = resolve(__dirname, '../../../../vendor/kicanvas');
const PINNED = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095';
const FORBIDDEN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'Nunito'];
// Both vendored trees are hashed: third_party/earcut is a real dependency of
// the WebGL renderer (and the only thing src/ takes from upstream's
// third_party/), so leaving it outside the manifest would put compiled input
// outside the integrity gate.
const VENDORED_DIRS = ['src', 'third_party/earcut'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('vendored KiCanvas', () => {
  const files = VENDORED_DIRS.flatMap((d) => walk(join(VENDOR, d))).sort();
  const manifest = new Map(
    readFileSync(join(VENDOR, 'MANIFEST.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, path] = line.split(/\s+/);
        return [path ?? '', hash ?? ''] as const;
      }),
  );

  it('pins the commit this spec names', () => {
    expect(readFileSync(join(VENDOR, 'UPSTREAM'), 'utf8').split('\n')[1]).toBe(PINNED);
  });

  it('matches its manifest file for file', () => {
    expect(files.length).toBe(manifest.size);
    for (const f of files) {
      const rel = relative(VENDOR, f).split('\\').join('/');
      const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
      expect(manifest.get(rel), rel).toBe(hash);
    }
  });

  it('references no web-font host anywhere in the tree', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const host of FORBIDDEN) expect(text.includes(host), `${relative(VENDOR, f)} mentions ${host}`).toBe(false);
    }
  });
});
