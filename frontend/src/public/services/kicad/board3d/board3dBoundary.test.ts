import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Spec 2026-09-21 §3.2 / §8: the convention "only kicanvasController touches
// KiCanvas" is a GATE for this subsystem, and three.js may only be imported
// under components/kicad/board3d. This scan is the enforcement.
const SERVICE = __dirname;
const HOST = join(__dirname, '../../../components/kicad/board3d');
const PUBLIC = join(__dirname, '../../..');

/** A three.js import in either form: static `from 'three…'` or dynamic
 *  `import('three…')` — the renderer itself uses the dynamic one. */
const THREE_IMPORT = /(?:from\s*|import\s*\()\s*['"]three/;
/** Every way a module can talk to the network, not only `fetch(`. */
const NETWORK = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'new Image'];

/** The pipeline's own files plus the modules OUTSIDE its directory that it
 *  imports (`../sexpr`, `../types`): a boundary that stops at the folder edge
 *  is one relative import away from meaning nothing. */
function pipelineFiles(): string[] {
  const own = walk(SERVICE);
  const outside = new Set<string>();
  for (const file of own) {
    for (const m of readFileSync(file, 'utf8').matchAll(/from\s*['"](\.\.\/[^'"]+)['"]/g)) {
      const base = join(SERVICE, m[1]);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        try {
          if (statSync(candidate).isFile()) outside.add(candidate);
        } catch {
          // not this spelling
        }
      }
    }
  }
  return [...own, ...outside];
}

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
    const files = pipelineFiles();
    // …and the scan really does reach past the folder.
    expect(files.some((f) => f.endsWith(join('kicad', 'sexpr.ts')))).toBe(true);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', 'document.', 'window.', ...NETWORK]) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
      expect(src, `${file} imports three`).not.toMatch(THREE_IMPORT);
    }
  });
  it('the host never touches KiCanvas or the network', () => {
    for (const file of walk(HOST)) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', ...NETWORK]) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('three is imported nowhere else under src/public', () => {
    for (const file of walk(PUBLIC)) {
      if (file.startsWith(HOST)) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(THREE_IMPORT);
    }
  });
  it('the patterns see both import forms', () => {
    expect("const T = await import('three');").toMatch(THREE_IMPORT);
    expect('import { Mesh } from "three";').toMatch(THREE_IMPORT);
    expect("import('three/examples/jsm/controls/OrbitControls.js')").toMatch(THREE_IMPORT);
  });
  it('the renderer, the one sanctioned importer, is seen by the pattern', () => {
    expect(readFileSync(join(HOST, 'sceneRenderer.ts'), 'utf8')).toMatch(THREE_IMPORT);
  });
  it('the bundler names only earcut into the board3d chunk, never the pipeline', () => {
    // Naming the pipeline's folder in manualChunks made Rollup pull its shared
    // deps (services/kicad/types.ts, sexpr.ts) into that chunk, and the /bom
    // and /viewer route chunks then imported it statically — earcut and the
    // whole 3D pipeline on every visit. The pipeline splits by itself behind
    // the lazy Board3DView; only earcut needs naming.
    const config = readFileSync(join(__dirname, '../../../../../vite.config.ts'), 'utf8');
    expect(config).toMatch(/node_modules\/earcut\//);
    expect(config).not.toMatch(/id\.includes\(['"][^'"]*services\/kicad\/board3d/);
  });
});
