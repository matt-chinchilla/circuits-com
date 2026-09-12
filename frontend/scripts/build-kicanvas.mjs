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
// Everything the bundle compiles is hashed, so the gate guards the whole input
// and not just src/ -- third_party/earcut is a real dependency of the WebGL
// renderer (src/graphics/webgl/vector.ts) and the only thing src/ takes from
// upstream's third_party/. Keep in step with vendor-kicanvas.mjs.
const VENDORED_DIRS = ['src', 'third_party/earcut'];
// The four elements the site mounts. This looks for the REGISTRATION CALL, not
// the bare name, and that distinction is the whole point: `kc-board-app` and
// `kc-schematic-app` also occur in kicanvas-embed's CSS selector and its html
// template, so a bundle that never registers them still contains each string
// three times. A hash-clean, font-clean 142 KB bundle with no renderers, no
// viewers and no fonts in it passed every other check here once -- the embed
// only type-imports those two classes, so entry.ts has to import them for
// their side effect or they (and everything they pull) vanish.
const REQUIRED_ELEMENTS = ['kicanvas-embed', 'kicanvas-source', 'kc-board-app', 'kc-schematic-app'];

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
for (const file of VENDORED_DIRS.flatMap((d) => walk(join(VENDOR, d)))) {
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
for (const el of REQUIRED_ELEMENTS) {
  if (!out.includes(`define("${el}"`) && !out.includes(`define('${el}'`)) {
    fail(`bundle never registers <${el}> — entry.ts is probably missing a side-effect import`);
  }
}
console.log(`build-kicanvas: ${OUT} ${out.length.toLocaleString('en-US')} bytes`);
