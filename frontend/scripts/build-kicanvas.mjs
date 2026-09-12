// frontend/scripts/build-kicanvas.mjs
// Bundles the vendored KiCanvas tree into vendor/build/kicanvas.js with the
// SAME options upstream uses (scripts/bundle.js + build.js's minify) — the
// .css/.svg/.glsl/.kicad_wks loaders are TEXT, which is why Vite cannot
// compile the tree directly. The script is also the integrity gate: it fails
// the image build if the tree drifted from MANIFEST.sha256 or if a web-font
// host survives in the output (spec §5.1). Runs as `prebuild` and `predev`.
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const VENDOR = resolve(import.meta.dirname, '../vendor/kicanvas');
const OUT = resolve(import.meta.dirname, '../vendor/build/kicanvas.js');
const FORBIDDEN = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function fail(message) {
  console.error(`build-kicanvas: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const manifest = new Map(
  readFileSync(join(VENDOR, 'MANIFEST.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, path] = line.split(/\s+/);
      return [path, hash];
    }),
);
for (const file of walk(join(VENDOR, 'src'))) {
  const rel = relative(VENDOR, file).split('\\').join('/');
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (manifest.get(rel) !== hash) fail(`vendored file drifted from the manifest: ${rel}`);
  manifest.delete(rel);
}
if (manifest.size > 0) fail(`manifest names files that are gone: ${[...manifest.keys()].join(', ')}`);

// Upstream's CSS minify plugin (scripts/bundle.js), verbatim in spirit.
const cssMinify = {
  name: 'css-minify',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await esbuild.transform(readFileSync(args.path, 'utf8'), { loader: 'css', minify: true });
      return { loader: 'text', contents: css.code };
    });
  },
};

mkdirSync(dirname(OUT), { recursive: true });
await esbuild.build({
  entryPoints: [join(VENDOR, 'entry.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  keepNames: true,
  sourcemap: false,
  minify: true,
  loader: { '.js': 'ts', '.glsl': 'text', '.css': 'text', '.svg': 'text', '.kicad_wks': 'text' },
  define: { DEBUG: 'false' },
  tsconfig: join(VENDOR, 'tsconfig.json'),
  plugins: [cssMinify],
  logLevel: 'warning',
});

const out = readFileSync(OUT, 'utf8');
for (const host of FORBIDDEN) if (out.includes(host)) fail(`bundle references ${host}`);
console.log(`build-kicanvas: ${OUT} ${out.length.toLocaleString('en-US')} bytes`);
