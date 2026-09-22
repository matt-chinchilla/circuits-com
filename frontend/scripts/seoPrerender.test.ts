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
  BODY_ATTR,
  BODY_FLASH_GUARD,
  PART_LINKS_PER_LIST,
  PART_TREE_FANOUT,
  SITEMAP_PARTS_PAGE_SIZE,
  buildRoutes,
  buildSitemaps,
  partTreeLinks,
  renderBody,
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

  it('a subcategory document serves its part links as real anchors, not noscript text', () => {
    // The 2026-09-01 audit measured 233–906 chars of crawlable text, all of it
    // inside <noscript>. A script-enabled HTML parser keeps noscript content as
    // raw text, so those links were not links to it at all.
    const { dir } = build(SUBCAT_MANIFEST);
    const html = readFileSync(path.join(dir, 'category/ics/regs/index.html'), 'utf8');
    expect(html).not.toContain('<noscript');

    const root = /<div id="root">([\s\S]*?)<\/div>\s*<script/.exec(html)?.[1] ?? '';
    expect(root.startsWith('<main data-seo-body>')).toBe(true);
    const anchors = [...root.matchAll(/<a href="(\/part\/[^"]+)">([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(anchors).toEqual(['/part/lm7805ct', '/part/lm317t', '/part/page-one']);
    expect(root).toContain('<h2>Voltage Regulators parts</h2>');
  });

  it('hides the body from a script-enabled browser with an UNMARKED guard', () => {
    // Marked tags are stripped by @shared/seoPrerenderHandoff before the first
    // render, and React's first commit is scheduled — a marked guard would let
    // the body flash unstyled in between.
    const { dir } = build(SUBCAT_MANIFEST);
    const html = readFileSync(path.join(dir, 'category/ics/regs/index.html'), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(BODY_FLASH_GUARD);
    expect(BODY_FLASH_GUARD).not.toContain('data-seo-prerendered');
    expect(BODY_FLASH_GUARD).toContain('@media (scripting: enabled)');
    expect(BODY_FLASH_GUARD).toContain(`[${BODY_ATTR}]`);
  });
});

// ── The crawlable body ──────────────────────────────────────────────────────

const SUBCAT_MANIFEST: SeoManifest = {
  categories: [
    {
      slug: 'ics',
      name: 'Integrated Circuits',
      description: 'ICs of every kind.',
      children: [
        {
          slug: 'regs',
          name: 'Voltage Regulators',
          description: null,
          // Page-1 links: one duplicates a ranked part and must not repeat.
          parts: [
            { href: '/part/lm7805ct', label: 'LM7805CT' },
            { href: '/part/page-one', label: 'PAGE-ONE', note: 'Acme' },
          ],
        },
        { slug: 'timers', name: 'Timers', description: null },
      ],
    },
  ],
  parts: [
    part('lm7805ct', { manufacturerName: 'Texas Instruments', description: 'Linear regulator 5V 1.5A TO-220' }),
    part('lm317t', { manufacturerName: 'STMicroelectronics' }),
  ],
};

function bodyOf(routes: PrerenderRoute[], urlPath: string) {
  const route = routes.find((r) => r.urlPath === urlPath);
  if (!route?.body) throw new Error(`no body for ${urlPath}`);
  return { body: route.body, html: renderBody(route.body) };
}

describe('the crawlable body', () => {
  const routes = buildRoutes(SUBCAT_MANIFEST);

  it('a subcategory lists its prerendered parts first, then tops up from page 1', () => {
    const { body } = bodyOf(routes, '/category/ics/regs');
    const partsSection = body.sections.find((s) => s.title === 'Voltage Regulators parts');
    expect(partsSection?.links.map((l) => l.href)).toEqual([
      '/part/lm7805ct',
      '/part/lm317t',
      '/part/page-one',
    ]);
    // The anchor is the MPN; the maker and a clipped description follow it.
    expect(partsSection?.links[0]).toEqual({
      href: '/part/lm7805ct',
      label: 'LM7805CT',
      note: 'Texas Instruments · Linear regulator 5V 1.5A TO-220',
    });
  });

  it('never lists more than a screenful of parts', () => {
    const manifest: SeoManifest = {
      categories: [{ slug: 'ics', name: 'ICs', children: [{ slug: 'regs', name: 'Regs' }] }],
      parts: manyParts(PART_LINKS_PER_LIST + 10),
    };
    const { body } = bodyOf(buildRoutes(manifest), '/category/ics/regs');
    expect(body.sections[0].links).toHaveLength(PART_LINKS_PER_LIST);
  });

  it('a subcategory carries its breadcrumb, a heading, prose and its siblings', () => {
    const { html } = bodyOf(routes, '/category/ics/regs');
    expect(html).toContain(
      '<nav aria-label="Breadcrumb"><a href="/">Circuit Center</a> › ' +
        '<a href="/category/ics">Integrated Circuits</a></nav>',
    );
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<h1>Voltage Regulators</h1>');
    expect(html).toContain(
      'Manufacturers listed in Voltage Regulators on Circuit Center include ' +
        'STMicroelectronics and Texas Instruments.',
    );
    expect(html).toContain('<h2>More in Integrated Circuits</h2><ul><li><a href="/category/ics/timers">Timers</a></li></ul>');
  });

  it('does not double the full stop after a manufacturer that ends in one', () => {
    const manifest: SeoManifest = {
      categories: [{ slug: 'ics', name: 'ICs', children: [{ slug: 'regs', name: 'Regs' }] }],
      parts: [part('ap2112k', { manufacturerName: 'Diodes Inc.' })],
    };
    const { html } = bodyOf(buildRoutes(manifest), '/category/ics/regs');
    expect(html).toContain('include Diodes Inc.</p>');
  });

  it('a top-level category carries its description, its subcategories and its parts', () => {
    const { html } = bodyOf(routes, '/category/ics');
    expect(html).toContain('<p>ICs of every kind.</p>');
    expect(html).toContain('<h2>Integrated Circuits subcategories</h2>');
    expect(html).toContain('<a href="/category/ics/regs">Voltage Regulators</a>');
    expect(html).toContain('<h2>Integrated Circuits parts</h2>');
    expect(html).toContain('<a href="/part/lm7805ct">LM7805CT</a>');
  });

  it('an empty section renders no heading', () => {
    // Timers has no parts of either kind: no "Timers parts" heading over nothing.
    const { html } = bodyOf(routes, '/category/ics/timers');
    expect(html).not.toContain('Timers parts');
  });

  it('escapes what it renders', () => {
    const manifest: SeoManifest = {
      categories: [
        { slug: 'ics', name: 'ICs <b>', description: '</main><script>alert(1)</script>', children: [] },
      ],
    };
    const { html } = bodyOf(buildRoutes(manifest), '/category/ics');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;/main&gt;&lt;script&gt;');
    expect(html).toContain('<h1>ICs &lt;b&gt;</h1>');
  });

  it('every prerendered part in a category is reachable: 25 from the category, 8 from each part', () => {
    const n = 2_442; // resistors, the largest group on 2026-09-22
    const manifest: SeoManifest = {
      categories: [{ slug: 'ics', name: 'ICs', children: [{ slug: 'regs', name: 'Regs' }] }],
      parts: manyParts(n),
    };
    const built = buildRoutes(manifest);
    const inbound = new Map<string, number>();
    for (const route of built) {
      for (const section of route.body?.sections ?? []) {
        for (const link of section.links) {
          if (link.href.startsWith('/part/')) {
            // The top-level category repeats the subcategory's first screen;
            // count the tree the subcategory and the part documents form.
            if (route.urlPath === '/category/ics') continue;
            inbound.set(link.href, (inbound.get(link.href) ?? 0) + 1);
          }
        }
      }
    }
    const partUrls = built.filter((r) => r.urlPath.startsWith('/part/')).map((r) => r.urlPath);
    expect(partUrls).toHaveLength(n);
    for (const url of partUrls) expect(inbound.get(url), url).toBe(1);
    for (const route of built) {
      const links = route.body?.sections.flatMap((s) => s.links) ?? [];
      if (route.urlPath.startsWith('/part/')) expect(links.length).toBeLessThanOrEqual(PART_TREE_FANOUT);
    }
  });

  it('partTreeLinks gives every index past the first screen exactly one parent', () => {
    const group = Array.from({ length: 500 }, (_, i) => i);
    const parents = new Map<number, number>();
    group.forEach((_, i) => {
      for (const child of partTreeLinks(group, i)) parents.set(child, (parents.get(child) ?? 0) + 1);
    });
    for (let i = 0; i < group.length; i += 1) {
      expect(parents.get(i) ?? 0).toBe(i < PART_LINKS_PER_LIST ? 0 : 1);
    }
  });
});

describe('the committed manifest renders within budget', () => {
  // A regen against prod is what moves these numbers; a guard here keeps a
  // richer body from quietly growing every document on disk.
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../seo-manifest.json'), 'utf8'),
  ) as SeoManifest;
  const routes = buildRoutes(manifest);

  it('keeps every category body under ~6 KB', () => {
    const categoryRoutes = routes.filter((r) => r.urlPath.startsWith('/category/'));
    expect(categoryRoutes.length).toBeGreaterThan(0);
    for (const route of categoryRoutes) {
      expect(Buffer.byteLength(renderBody(route.body!)), route.urlPath).toBeLessThanOrEqual(6_144);
    }
  });

  it('links every prerendered part document from at least one other document', () => {
    const linked = new Set<string>();
    for (const route of routes) {
      for (const section of route.body?.sections ?? []) for (const l of section.links) linked.add(l.href);
    }
    const orphans = routes.filter((r) => r.urlPath.startsWith('/part/') && !linked.has(r.urlPath));
    expect(orphans.map((r) => r.urlPath)).toEqual([]);
  });
});
