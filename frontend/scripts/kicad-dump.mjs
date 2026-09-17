// frontend/scripts/kicad-dump.mjs
// Usage: node scripts/kicad-dump.mjs <project-dir-or-zip>
// Bundles kicad-dump-entry.ts for node with the same aliases the app uses,
// then runs it. The reader is browser code with no DOM dependency, so node's
// File/Blob (20+) is enough.
import esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/kicad-dump.mjs <project-dir-or-zip>');
  process.exit(2);
}
const here = import.meta.dirname;
const dir = mkdtempSync(join(tmpdir(), 'kicad-dump-'));
const out = join(dir, 'entry.mjs');
try {
  await esbuild.build({
    entryPoints: [join(here, 'kicad-dump-entry.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@public': resolve(here, '../src/public'), '@shared': resolve(here, '../src/shared') },
    logLevel: 'warning',
  });
  const { dump } = await import(pathToFileURL(out).href);
  await dump(resolve(target));
} finally {
  // The bundle is an artefact of THIS run and nothing outside it reads the
  // directory, so it goes whether the dump finished or threw — one `entry.mjs`
  // dir per invocation was accumulating in the OS tmpdir. `dump` is awaited
  // above, so the module is fully evaluated before its file disappears.
  rmSync(dir, { recursive: true, force: true });
}
