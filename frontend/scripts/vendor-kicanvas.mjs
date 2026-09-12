// frontend/scripts/vendor-kicanvas.mjs
// Re-vendors KiCanvas from the pinned commit: copies src/, tsconfig.json and
// LICENSE.md into vendor/kicanvas, applies patches/*.patch in order, and writes
// UPSTREAM + MANIFEST.sha256. Run by hand, only on a deliberate upstream bump.
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

export function writeManifest() {
  const files = walk(join(VENDOR, 'src')).sort();
  const lines = files.map((f) => `${sha256(f)}  ${relative(VENDOR, f).split('\\').join('/')}`);
  writeFileSync(join(VENDOR, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const work = join(tmpdir(), `kicanvas-${SHA.slice(0, 8)}`);
  rmSync(work, { recursive: true, force: true });
  execSync(`git clone --quiet ${REPO} ${work}`, { stdio: 'inherit' });
  execSync(`git -C ${work} checkout --quiet ${SHA}`, { stdio: 'inherit' });

  rmSync(join(VENDOR, 'src'), { recursive: true, force: true });
  mkdirSync(join(VENDOR, 'patches'), { recursive: true });
  cpSync(join(work, 'src'), join(VENDOR, 'src'), { recursive: true });
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
