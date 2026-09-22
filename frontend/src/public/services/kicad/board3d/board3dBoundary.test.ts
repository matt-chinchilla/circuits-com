import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Spec 2026-09-21 §3.2 / §8: the convention "only kicanvasController touches
// KiCanvas" is a GATE for this subsystem, and three.js may only be imported
// under components/kicad/board3d. This scan is the enforcement.
const SERVICE = __dirname;
const HOST = join(__dirname, '../../../components/kicad/board3d');
const PUBLIC = join(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('board3d import boundary', () => {
  it('the pure pipeline never touches KiCanvas, three, the DOM or the network', () => {
    for (const file of walk(SERVICE)) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', "from 'three", 'document.', 'window.', 'fetch(']) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('the host never touches KiCanvas or the network', () => {
    for (const file of walk(HOST)) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', 'fetch(']) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('three is imported nowhere else under src/public', () => {
    for (const file of walk(PUBLIC)) {
      if (file.startsWith(HOST)) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]three/);
    }
  });
});
