// frontend/scripts/vendor-kicanvas.mjs
// Re-vendors KiCanvas from the pinned commit: copies src/, third_party/earcut/,
// tsconfig.json and LICENSE.md into vendor/kicanvas, applies patches/*.patch in
// order, and writes UPSTREAM + MANIFEST.sha256. Run by hand, only on a
// deliberate upstream bump.
//
// third_party/earcut is NOT optional: src/graphics/webgl/vector.ts imports it
// from ../../../third_party/earcut/earcut, so a tree without it cannot build
// the WebGL renderer at all. It is hashed into the manifest alongside src/ --
// anything the bundle compiles has to sit inside the integrity gate, or the
// gate is only guarding half the input.
//
// earcut is the ONLY thing src/ pulls from upstream's third_party/, which is
// why this vendors that one subdirectory rather than the whole tree. The rest
// is third_party/newstroke: 16 MB of KiCad font-authoring sources (.lib/.sch/
// .kicad_pcb/.cpp) that are the PROVENANCE of src/kicad/text/newstroke-glyphs.ts,
// a generated file already inside src/. Nothing imports them, and committing
// them would grow .git by ~38% and quadruple the frontend Docker build context
// that .dockerignore exists to keep near 5 MB. To widen the set later, add the
// subdirectory here -- the manifest and both gates follow this constant.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const REPO = 'https://github.com/theacodes/kicanvas';
const SHA = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095';
const DATE = '2026-04-28';
const VENDOR = resolve(import.meta.dirname, '../vendor/kicanvas');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

export function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export const VENDORED_DIRS = ['src', 'third_party/earcut'];

export function writeManifest() {
  const files = VENDORED_DIRS.flatMap((d) => walk(join(VENDOR, d))).sort();
  const lines = files.map((f) => `${sha256(f)}  ${relative(VENDOR, f).split('\\').join('/')}`);
  writeFileSync(join(VENDOR, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const work = join(tmpdir(), `kicanvas-${SHA.slice(0, 8)}`);
  rmSync(work, { recursive: true, force: true });
  execSync(`git clone --quiet ${REPO} ${work}`, { stdio: 'inherit' });
  execSync(`git -C ${work} checkout --quiet ${SHA}`, { stdio: 'inherit' });

  for (const d of ['src', 'third_party']) rmSync(join(VENDOR, d), { recursive: true, force: true });
  mkdirSync(join(VENDOR, 'patches'), { recursive: true });
  for (const d of VENDORED_DIRS) cpSync(join(work, d), join(VENDOR, d), { recursive: true });
  for (const f of ['tsconfig.json', 'LICENSE.md']) cpSync(join(work, f), join(VENDOR, f));
  writeFileSync(join(VENDOR, 'UPSTREAM'), `${REPO}\n${SHA}\n${DATE}\n`);

  for (const patch of readdirSync(join(VENDOR, 'patches')).filter((p) => p.endsWith('.patch')).sort()) {
    execSync(`git apply --directory=frontend/vendor/kicanvas ${join(VENDOR, 'patches', patch)}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    console.log(`applied ${patch}`);
  }

  const count = writeManifest();
  console.log(`vendored ${count} files at ${SHA.slice(0, 8)}`);
}
