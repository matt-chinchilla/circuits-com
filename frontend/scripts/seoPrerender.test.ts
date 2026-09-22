// The build-time prerender's sitemap half (2026-09-22).
//
// The weekly SEO audit of 2026-09-21 sampled 60 URLs out of the live
// sitemap-parts-1.xml and found 21 (35 %) serving the generic SPA shell: the
// API re-ranked the parts on every crawler fetch while the prerendered
// documents came from a snapshot committed three weeks earlier. The fix makes
// the sitemaps an OUTPUT of the same step that writes the documents, so the
// contract pinned here is an "if and only if" — every advertised part URL has
// a document in dist/, and every part document is advertised.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SITEMAP_PARTS_PAGE_SIZE,
  buildRoutes,
  buildSitemaps,
  writePrerender,
  type ManifestPart,
  type PrerenderRoute,
  type SeoManifest,
} from './seoPrerender';

const ORIGIN = 'https://circuitcenter.ai';
const SHELL = path.resolve(__dirname, '../index.html');

function part(slug: string, extra: Partial<ManifestPart> = {}): ManifestPart {
  return {
    slug,
    sku: slug.toUpperCase(),
    manufacturerName: 'Acme',
    categorySlug: 'regs',
    parentCategorySlug: 'ics',
    categoryName: 'Voltage Regulators',
    ...extra,
  };
}

function manyParts(n: number): ManifestPart[] {
  return Array.from({ length: n }, (_, i) => part(`p${i}`));
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
}

/** Part locs across every sitemap-parts-{n}.xml, in order. */
function partLocs(files: { file: string; xml: string }[]): string[] {
  return files.filter((f) => f.file.startsWith('sitemap-parts-')).flatMap((f) => locs(f.xml));
}

function sitemapsFor(manifest: SeoManifest, pageSize?: number) {
  return buildSitemaps(buildRoutes(manifest), manifest.generatedAt, pageSize);
}

describe('buildSitemaps — the part sitemaps derive from the prerendered routes', () => {
  it('advertises exactly the manifest parts, one <loc> each', () => {
    const manifest: SeoManifest = { parts: [part('lm7805ct'), part('ne555p'), part('bc547')] };
    expect(partLocs(sitemapsFor(manifest))).toEqual([
      `${ORIGIN}/part/lm7805ct`,
      `${ORIGIN}/part/ne555p`,
      `${ORIGIN}/part/bc547`,
    ]);
  });

  it('keeps the page size under the 50,000-URL protocol cap', () => {
    expect(SITEMAP_PARTS_PAGE_SIZE).toBe(45_000);
    expect(SITEMAP_PARTS_PAGE_SIZE).toBeLessThan(50_000);
  });

  it('splits at 45,000 locs a page — growth adds a page instead of breaching the cap', () => {
    const files = sitemapsFor({ parts: manyParts(SITEMAP_PARTS_PAGE_SIZE + 1) });
    const pages = files.filter((f) => f.file.startsWith('sitemap-parts-'));
    expect(pages.map((p) => p.file)).toEqual(['sitemap-parts-1.xml', 'sitemap-parts-2.xml']);
    expect(locs(pages[0].xml)).toHaveLength(SITEMAP_PARTS_PAGE_SIZE);
    expect(locs(pages[1].xml)).toHaveLength(1);
    for (const page of pages) expect(locs(page.xml).length).toBeLessThanOrEqual(50_000);
  });

  it('partitions the parts across pages with no gap and no repeat', () => {
    const manifest = { parts: manyParts(7) };
    const paged = partLocs(sitemapsFor(manifest, 3));
    expect(paged).toHaveLength(7);
    expect(new Set(paged).size).toBe(7);
  });

  it('the index names the core child plus every parts page that exists, at public URLs', () => {
    const files = sitemapsFor({ parts: manyParts(7) }, 3);
    const index = files.find((f) => f.file === 'sitemap.xml');
    expect(index?.xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locs(index!.xml)).toEqual([
      `${ORIGIN}/sitemap-core.xml`,
      `${ORIGIN}/sitemap-parts-1.xml`,
      `${ORIGIN}/sitemap-parts-2.xml`,
      `${ORIGIN}/sitemap-parts-3.xml`,
    ]);
    expect(locs(index!.xml).some((l) => l.includes('/api/'))).toBe(false);
  });

  it('with no parts, the index is core-only and no empty parts page is written', () => {
    const files = sitemapsFor({ parts: [] });
    expect(files.map((f) => f.file)).toEqual(['sitemap.xml']);
    expect(locs(files[0].xml)).toEqual([`${ORIGIN}/sitemap-core.xml`]);
  });

  it('a slug the prerender refuses gets neither a document nor a <loc>', () => {
    // A slug becomes a directory under dist/: separators, dots and the empty
    // string would write outside part/<slug>/ or onto the bare /part/ URL.
    const manifest = {
      parts: [part('ok-1'), part('../../etc'), part(''), part('UPPER'), part('a/b')],
    };
    const routes = buildRoutes(manifest).filter((r) => r.urlPath.startsWith('/part/'));
    expect(routes.map((r) => r.urlPath)).toEqual(['/part/ok-1']);
    expect(partLocs(sitemapsFor(manifest))).toEqual([`${ORIGIN}/part/ok-1`]);
  });

  it('a duplicated slug is one document and one <loc>', () => {
    const manifest = { parts: [part('twin', { manufacturerName: 'A' }), part('twin', { manufacturerName: 'B' })] };
    expect(partLocs(sitemapsFor(manifest))).toEqual([`${ORIGIN}/part/twin`]);
    const partRoutes = buildRoutes(manifest).filter((r) => r.urlPath === '/part/twin');
    expect(partRoutes).toHaveLength(1);
    // First wins — the same row /parts/by-slug returns first.
    expect(partRoutes[0].seo.title).toContain('by A');
  });

  it('XML-escapes what it writes', () => {
    // No manifest slug can carry these (SAFE_SLUG), so drive the builder
    // directly: the escaping is its own contract, not the slug filter's.
    const route = { urlPath: "/part/a&b<c>'\"", file: 'x', seo: {} } as unknown as PrerenderRoute;
    const [, page] = buildSitemaps([route], '2026-09-22T00:00:00.000Z');
    expect(page.xml).toContain(`<loc>${ORIGIN}/part/a&amp;b&lt;c&gt;&apos;&quot;</loc>`);
    expect(page.xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('stamps <lastmod> with the manifest date, and never on the live core child', () => {
    const files = sitemapsFor({ generatedAt: '2026-09-22T11:14:40.292Z', parts: [part('lm7805ct')] });
    const [index, page] = files;
    expect(page.xml).toContain(
      `<url><loc>${ORIGIN}/part/lm7805ct</loc><lastmod>2026-09-22</lastmod>` +
        `<changefreq>weekly</changefreq><priority>0.6</priority></url>`,
    );
    expect(index.xml).toContain(`<sitemap><loc>${ORIGIN}/sitemap-core.xml</loc></sitemap>`);
    expect(index.xml).toContain(
      `<sitemap><loc>${ORIGIN}/sitemap-parts-1.xml</loc><lastmod>2026-09-22</lastmod></sitemap>`,
    );
  });

  it('omits <lastmod> rather than invent one when the manifest has no usable date', () => {
    for (const generatedAt of [undefined, '', 'yesterday']) {
      const files = sitemapsFor({ generatedAt, parts: [part('lm7805ct')] });
      for (const f of files) expect(f.xml).not.toContain('<lastmod>');
    }
  });
});

describe('writePrerender — the documents and the sitemaps land together', () => {
  let outDir: string | null = null;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    outDir = null;
  });

  function build(manifest: SeoManifest | null) {
    outDir = mkdtempSync(path.join(tmpdir(), 'seo-prerender-'));
    copyFileSync(SHELL, path.join(outDir, 'index.html'));
    const manifestPath = path.join(outDir, 'seo-manifest.json');
    if (manifest) writeFileSync(manifestPath, JSON.stringify(manifest));
    const messages: string[] = [];
    const result = writePrerender(
      { manifestPath, outDir },
      { info: (m) => messages.push(m), warn: (m) => messages.push(m) },
    );
    return { result, messages, dir: outDir };
  }

  it('every advertised part URL is a document on disk, and every part document is advertised', () => {
    const { dir } = build({
      generatedAt: '2026-09-22T00:00:00.000Z',
      parts: [part('lm7805ct'), part('ne555p'), part('../escape'), part('lm7805ct')],
    });
    const index = readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
    const pageFiles = locs(index)
      .filter((l) => l.includes('/sitemap-parts-'))
      .map((l) => l.slice(ORIGIN.length + 1));
    expect(pageFiles).toEqual(['sitemap-parts-1.xml']);

    const advertised = pageFiles.flatMap((f) => locs(readFileSync(path.join(dir, f), 'utf8')));
    expect(advertised).toEqual([`${ORIGIN}/part/lm7805ct`, `${ORIGIN}/part/ne555p`]);
    for (const loc of advertised) {
      const doc = path.join(dir, loc.slice(ORIGIN.length), 'index.html');
      expect(existsSync(doc), `${loc} is advertised but has no document`).toBe(true);
      expect(readFileSync(doc, 'utf8')).toContain('application/ld+json');
    }
    expect(existsSync(path.join(dir, 'escape'))).toBe(false);
  });

  it('a missing manifest still writes a valid, core-only index', () => {
    const { dir, messages } = build(null);
    expect(locs(readFileSync(path.join(dir, 'sitemap.xml'), 'utf8'))).toEqual([
      `${ORIGIN}/sitemap-core.xml`,
    ]);
    expect(existsSync(path.join(dir, 'sitemap-parts-1.xml'))).toBe(false);
    expect(messages.some((m) => m.includes('missing or unreadable'))).toBe(true);
  });

  it('writes nothing at all without a built shell', () => {
    outDir = mkdtempSync(path.join(tmpdir(), 'seo-prerender-'));
    const result = writePrerender(
      { manifestPath: path.join(outDir, 'none.json'), outDir },
      { info: () => {}, warn: () => {} },
    );
    expect(result).toBeNull();
    expect(existsSync(path.join(outDir, 'sitemap.xml'))).toBe(false);
  });

  it('reports the part count it advertised in the build log', () => {
    const { messages } = build({ parts: [part('lm7805ct'), part('ne555p')] });
    expect(messages.join('\n')).toMatch(/2 part\) \+ 2 sitemap files advertising those 2 part URLs/);
  });
});
