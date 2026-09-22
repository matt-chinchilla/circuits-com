// Build-time SEO prerender — the reason circuitcenter.ai serves indexable HTML.
//
// The site is a client-rendered SPA behind nginx with no Node in the request
// path, so every URL used to resolve to one byte-identical index.html: same
// <title>, same meta description, no canonical, no JSON-LD. This step writes
// ONE static HTML file per templated route, each carrying that route's own head
// (built by @public/services/seo, the same module <PageHead> renders from) plus
// a crawlable body inside #root (see renderBody). nginx then serves them with
// the try_files rule already in frontend/nginx.conf — no runtime cost, no extra
// request-path service, and not one byte added to the JS bundle.
//
// Scope is every templated route: home, the static pages, EVERY category and
// subcategory, and a CAPPED slice of part pages.
//
// Parts were excluded in the first pass on the assumption that prerendering
// them would be expensive. It is not: renderRoute is regex replacement over the
// built shell, not React SSR, so each document costs a few string operations
// and one file write. That is why parts are here at all — they are ~97% of the
// sitemap, so excluding them left the overwhelming majority of the site on the
// generic shell, and part-number searches are the long tail a components
// directory actually wins.
//
// Cheap per document is not free in aggregate, though. Each part page is a
// ~13 KB file, so the catalog's 270k+ parts would be a multi-GB dist/ — past
// what the frontend image, the deploy and the t3.small disk can carry. The
// manifest therefore ships a RANKED slice (see gen-seo-manifest.mjs): parts
// with a photo AND a price first, then stock descending, then newest. Parts
// outside it serve the SPA shell and get their head tags from helmet after
// hydration, which is already what every part added since the last regen does.
//
// The part sitemaps are written HERE, from the same route list, not by the API
// (2026-09-22). /api/sitemap-parts-{n}.xml used to re-run the ranked query on
// every crawler fetch while the documents came from the committed manifest, so
// the two drifted apart every night as the feed moved stock: on 2026-09-21, 21
// of 60 sampled sitemap part URLs (35 %) served the generic shell. Deriving
// sitemap-parts-{n}.xml and the sitemap.xml index from the routes this step
// just wrote makes "advertised" and "prerendered" one set by construction.
// /sitemap-core.xml (static pages + categories) stays live on the API — the
// taxonomy moves only on a reseed. nginx serves these files ahead of the API
// (frontend/nginx.conf + nginx/nginx.ssl.conf; guard test_nginx_seo_prerender).
//
// The route data comes from seo-manifest.json, a snapshot committed alongside
// the code because the frontend build stage has no network and no database.
// Regenerate it with `node scripts/gen-seo-manifest.mjs` whenever the category
// taxonomy or its descriptions change, and after big imports — the sitemaps
// now move with it, so a stale manifest is a stale-but-TRUE sitemap rather
// than one that promises documents this build never wrote. A missing manifest
// degrades to the static routes and a core-only index; it never fails the build.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
  SITE_LINKS,
  SITE_ORIGIN,
  homeSeo,
  type PageSeo,
  type SeoLink,
} from '../src/public/services/seo';
import { STATIC_PAGE_SEO, categorySeo, partSeo } from '../src/public/services/seoRoutes';
import { categoryPath } from '../src/shared/utils/categoryPath';

export interface ManifestCategory {
  slug: string;
  name: string;
  description?: string | null;
  children?: {
    slug: string;
    name: string;
    description?: string | null;
    /**
     * Page-1 part links from /api/parts/ (sku order, what the live page opens
     * on). The body lists the subcategory's PRERENDERED parts first and only
     * tops up from these, so the generator fetches them only for a
     * subcategory with fewer than PART_LINKS_PER_LIST ranked parts.
     */
    parts?: BodyLink[];
  }[];
}

export interface ManifestPart {
  slug: string;
  sku: string;
  manufacturerName?: string | null;
  description?: string | null;
  categoryName?: string | null;
  categorySlug?: string | null;
  parentCategorySlug?: string | null;
  bestPrice?: number | null;
}

export interface SeoManifest {
  /** ISO timestamp of the regen — the part sitemaps' <lastmod>. */
  generatedAt?: string;
  categories?: ManifestCategory[];
  parts?: ManifestPart[];
}

export interface PrerenderRoute {
  /** Root-relative URL. */
  urlPath: string;
  /** Output file, relative to dist/. */
  file: string;
  seo: PageSeo;
  /** The crawlable body; absent = heading + description + links from `seo`. */
  body?: PrerenderBody;
}

/** A body link; `note` is plain text after the anchor (never part of it). */
export interface BodyLink extends SeoLink {
  note?: string;
}

/**
 * What a prerendered document carries inside #root for a client that runs no
 * JS — crawlers reading raw HTML (Bing's first pass, social and AI fetchers)
 * and no-JS browsers. The SPA's first commit replaces it (createRoot clears the
 * container), and a script-enabled browser never paints it (BODY_FLASH_GUARD),
 * so it costs a JS visitor nothing and never competes with the SPA's own <h1>.
 * It is the same content the SPA renders — heading, prose, subcategory links,
 * part links — so this is the page, not a crawler-only variant of it.
 */
export interface PrerenderBody {
  /** Trail above the heading, home first; empty on home itself. */
  breadcrumb: SeoLink[];
  heading: string;
  paragraphs: string[];
  /** An empty `title` renders the list with no <h2>. */
  sections: { title: string; links: BodyLink[] }[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A JSON-LD payload is injected as raw script content, so a literal "</script>"
// anywhere inside a description would close the block early. Escaping the
// opening angle bracket is valid JSON and valid JavaScript, and keeps the
// payload byte-identical to what JSON.parse sees.
function escapeJsonLd(json: string): string {
  return json.replace(/</g, '\\u003c');
}

// Every replacement below asserts it matched. The shell is generated by Vite
// from index.html; if that file's shape changes (a tag reworded, an attribute
// reordered) a silent no-op here would ship 97 pages carrying the generic head
// again, which is exactly the defect this step exists to fix. Failing the build
// is the only way that stays visible.
function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(html)) {
    throw new Error(
      `[seo-prerender] could not find ${what} in dist/index.html — the shell ` +
        `changed and the prerendered head would be wrong. Update scripts/seoPrerender.ts.`,
    );
  }
  return html.replace(pattern, () => replacement);
}

// Every tag <PageHead> also renders is marked, because helmet on React 19
// appends its copy instead of replacing ours. @shared/seoPrerenderHandoff
// removes the marked tags on boot so a JS client ends up with exactly one of
// each; a crawler that runs no JS keeps them. og:*/twitter:* are deliberately
// NOT marked — helmet renders no counterpart, so they have to survive.
const MARK = 'data-seo-prerendered';

function headTags(seo: PageSeo): string {
  const tags: string[] = [];
  if (seo.canonical) {
    tags.push(`<link ${MARK} rel="canonical" href="${escapeHtml(seo.canonical)}"/>`);
  }
  if (seo.robots) {
    tags.push(`<meta ${MARK} name="robots" content="${escapeHtml(seo.robots)}"/>`);
  }
  for (const json of seo.jsonLd) {
    tags.push(`<script ${MARK} type="application/ld+json">${escapeJsonLd(json)}</script>`);
  }
  return tags.join('\n    ');
}

// The body used to be a <noscript> stub (233–906 chars of text, audit
// 2026-09-01): a script-enabled parser keeps noscript content as raw text, so
// the part links in it were weak or invisible to any crawler that parses HTML
// the way a browser does. It is real DOM now, and this rule is what keeps a JS
// visitor from seeing it flash unstyled before the SPA's first commit — the
// exact visibility <noscript> gave it, without hiding it from the DOM. Browsers
// without the `scripting` media feature (pre-2023) show it until that commit.
// Deliberately NOT marked with MARK: the handoff strips marked tags BEFORE the
// first render, and React's first commit is scheduled, not synchronous.
export const BODY_ATTR = 'data-seo-body';
export const BODY_FLASH_GUARD = `<style>@media (scripting: enabled){[${BODY_ATTR}]{display:none}}</style>`;

function linkItem(link: BodyLink): string {
  const note = link.note ? ` — ${escapeHtml(link.note)}` : '';
  return `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${note}</li>`;
}

export function renderBody(body: PrerenderBody): string {
  const trail = body.breadcrumb.length
    ? `<nav aria-label="Breadcrumb">${body.breadcrumb
        .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
        .join(' › ')}</nav>`
    : '';
  const prose = body.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const sections = body.sections
    .filter((s) => s.links.length > 0)
    .map(
      (s) =>
        (s.title ? `<h2>${escapeHtml(s.title)}</h2>` : '') +
        `<ul>${s.links.map(linkItem).join('')}</ul>`,
    )
    .join('');
  return `<main ${BODY_ATTR}>${trail}<h1>${escapeHtml(body.heading)}</h1>${prose}${sections}</main>`;
}

function defaultBody(seo: PageSeo): PrerenderBody {
  return {
    breadcrumb: [],
    heading: seo.heading,
    paragraphs: [seo.description],
    sections: [{ title: '', links: seo.links }],
  };
}

export function renderRoute(shell: string, route: PrerenderRoute): string {
  const { seo } = route;
  let html = shell;
  html = replaceOnce(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(seo.title)}</title>`, '<title>');
  html = replaceOnce(
    html,
    /<meta name="description" content="[\s\S]*?"\s*\/>/,
    `<meta ${MARK} name="description" content="${escapeHtml(seo.description)}"/>`,
    'the description meta',
  );
  html = replaceOnce(
    html,
    /<meta property="og:title" content="[\s\S]*?"\s*\/>/,
    `<meta property="og:title" content="${escapeHtml(seo.title)}"/>`,
    'the og:title meta',
  );
  html = replaceOnce(
    html,
    /<meta property="og:description" content="[\s\S]*?"\s*\/>/,
    `<meta property="og:description" content="${escapeHtml(seo.description)}"/>`,
    'the og:description meta',
  );
  html = replaceOnce(
    html,
    /<meta name="twitter:title" content="[\s\S]*?"\s*\/>/,
    `<meta name="twitter:title" content="${escapeHtml(seo.title)}"/>`,
    'the twitter:title meta',
  );
  html = replaceOnce(
    html,
    /<meta name="twitter:description" content="[\s\S]*?"\s*\/>/,
    `<meta name="twitter:description" content="${escapeHtml(seo.description)}"/>`,
    'the twitter:description meta',
  );
  // og:url tracks the served URL even where canonical is absent (/search),
  // otherwise every non-canonical route would share the home page's preview.
  html = replaceOnce(
    html,
    /<meta property="og:url" content="[\s\S]*?"\s*\/>/,
    `<meta property="og:url" content="${escapeHtml(seo.canonical ?? SITE_ORIGIN + route.urlPath)}"/>`,
    'the og:url meta',
  );
  html = replaceOnce(
    html,
    /<\/head>/,
    `  ${headTags(seo)}\n    ${BODY_FLASH_GUARD}\n  </head>`,
    '</head>',
  );
  html = replaceOnce(
    html,
    /<div id="root"><\/div>/,
    `<div id="root">${renderBody(route.body ?? defaultBody(seo))}</div>`,
    'the empty #root div',
  );
  return html;
}

function readManifest(manifestPath: string): SeoManifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as SeoManifest;
  } catch {
    return null;
  }
}

/** Part links per list — one screenful, matching the live page's 25 rows. */
export const PART_LINKS_PER_LIST = 25;

/**
 * Sibling links a part document carries. Together with the 25 a subcategory
 * document lists, this makes every prerendered part reachable by crawlable
 * links (see partTreeLinks) — until 2026-09-22 only 341 of 14,977 part
 * documents had an internal link at all.
 */
export const PART_TREE_FANOUT = 8;

const MANUFACTURERS_NAMED = 8;
const NOTE_MAX = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function partLink(part: ManifestPart): BodyLink {
  const note = [part.manufacturerName, part.description ? clip(part.description, NOTE_MAX) : null]
    .filter(Boolean)
    .join(' · ');
  return { href: `/part/${part.slug}`, label: part.sku, ...(note ? { note } : {}) };
}

/** Root-relative category URL a part belongs to, the key its siblings share. */
function groupKey(part: ManifestPart): string | null {
  return part.categorySlug ? categoryPath(part.categorySlug, part.parentCategorySlug ?? null) : null;
}

/**
 * "Manufacturers listed in X include A, B and C." — named from the prerendered
 * parts in the category, most-listed first. It is the one sentence of body copy
 * that differs between subcategories whose descriptions are still the shared
 * template (every child on 2026-09-22), and it claims nothing but "listed".
 */
function manufacturersSentence(name: string, parts: ManifestPart[]): string | null {
  const counts = new Map<string, number>();
  for (const p of parts) {
    const m = p.manufacturerName?.trim();
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const names = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MANUFACTURERS_NAMED)
    .map(([m]) => m);
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  // "Diodes Inc." already ends the sentence; a second stop reads as a typo.
  return `Manufacturers listed in ${name} on Circuit Center include ${list}${list.endsWith('.') ? '' : '.'}`;
}

/**
 * The part documents part `index` of its category group links to: a
 * PART_TREE_FANOUT-ary tree over the group's ranked list whose first
 * PART_LINKS_PER_LIST entries hang off the category document itself. Every
 * index past the first screen has exactly one parent, so the whole group is
 * reachable in a handful of hops (2,442 resistors: depth 4 from the
 * subcategory page) with no document carrying more than 8 extra links.
 */
export function partTreeLinks<T>(group: T[], index: number): T[] {
  const start = PART_LINKS_PER_LIST + index * PART_TREE_FANOUT;
  return group.slice(start, start + PART_TREE_FANOUT);
}

// A slug becomes a directory under dist/ AND a <loc> in a sitemap, so it must
// be exactly the grammar slugify_sku emits: no separators to climb out of
// part/, nothing a URL would have to percent-encode, never empty (which would
// write part/index.html for the bare /part/ URL). A part that fails it gets no
// document and — because the sitemaps derive from these routes — no <loc>.
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The manifest's parts, filtered to the ones that get a document, in rank order. */
function prerenderedParts(manifest: SeoManifest | null): ManifestPart[] {
  const seen = new Set<string>();
  const out: ManifestPart[] = [];
  for (const part of manifest?.parts ?? []) {
    // One document per URL: the generator already dedupes slugs (first wins,
    // as /parts/by-slug does); a repeat here would overwrite the first file.
    if (!SAFE_SLUG.test(part.slug) || seen.has(part.slug)) continue;
    seen.add(part.slug);
    out.push(part);
  }
  return out;
}

export function buildRoutes(manifest: SeoManifest | null): PrerenderRoute[] {
  const categories = manifest?.categories ?? [];
  const topLevelLinks: SeoLink[] = categories.map((c) => ({
    href: `/category/${c.slug}`,
    label: c.name,
  }));

  const parts = prerenderedParts(manifest);
  // Rank order is preserved inside every group: the manifest is already sorted
  // best-first, and a stable filter keeps it that way.
  const byGroup = new Map<string, ManifestPart[]>();
  for (const part of parts) {
    const key = groupKey(part);
    if (!key) continue;
    const group = byGroup.get(key);
    if (group) group.push(part);
    else byGroup.set(key, [part]);
  }
  const nameByPath = new Map<string, string>();
  for (const c of categories) {
    nameByPath.set(`/category/${c.slug}`, c.name);
    for (const child of c.children ?? []) nameByPath.set(`/category/${c.slug}/${child.slug}`, child.name);
  }

  const home = homeSeo(topLevelLinks);
  // Home is written to home.html, NOT index.html. index.html stays the generic
  // SPA fallback for every route this step does not cover (part pages, keyword
  // profiles, 404s); baking home's canonical into it would make all 3,600 part
  // URLs declare `rel=canonical -> /`. nginx maps `location = /` to home.html.
  const routes: PrerenderRoute[] = [
    {
      urlPath: '/',
      file: 'home.html',
      seo: home,
      body: {
        breadcrumb: [],
        heading: home.heading,
        paragraphs: [home.description],
        sections: [
          { title: 'Browse electronic components by category', links: topLevelLinks },
          { title: 'Circuit Center', links: SITE_LINKS },
        ],
      },
    },
    { urlPath: '/about', file: 'about/index.html', seo: STATIC_PAGE_SEO.about },
    { urlPath: '/contact', file: 'contact/index.html', seo: STATIC_PAGE_SEO.contact },
    // No '/pricing' entry: that route merged into /join on 2026-08-14 and now
    // client-redirects there. Prerendering a document for it would serve a
    // self-canonical page for a URL whose content lives somewhere else.
    { urlPath: '/join', file: 'join/index.html', seo: STATIC_PAGE_SEO.join },
    { urlPath: '/bom', file: 'bom/index.html', seo: STATIC_PAGE_SEO.bom },
    { urlPath: '/viewer', file: 'viewer/index.html', seo: STATIC_PAGE_SEO.viewer },
    { urlPath: '/keyword', file: 'keyword/index.html', seo: STATIC_PAGE_SEO.keyword },
    { urlPath: '/privacy', file: 'privacy/index.html', seo: STATIC_PAGE_SEO.privacy },
    // /terms shared the privacy canonical while it rendered the privacy
    // component. It is its own document now, so it gets its own head — leaving
    // the old alias would have every terms URL declare itself a duplicate of
    // /privacy and drop out of the index.
    { urlPath: '/terms', file: 'terms/index.html', seo: STATIC_PAGE_SEO.terms },
    {
      urlPath: '/acceptable-use',
      file: 'acceptable-use/index.html',
      seo: STATIC_PAGE_SEO.acceptableUse,
    },
    { urlPath: '/search', file: 'search/index.html', seo: STATIC_PAGE_SEO.search },
  ];

  const homeCrumb: SeoLink = { href: '/', label: 'Circuit Center' };

  for (const category of categories) {
    const children = category.children ?? [];
    const topPath = `/category/${category.slug}`;
    const childLinks: SeoLink[] = children.map((c) => ({
      href: `${topPath}/${c.slug}`,
      label: c.name,
    }));
    const seo = categorySeo({
      name: category.name,
      canonicalPath: topPath,
      description: category.description ?? null,
      children: childLinks,
    });
    // The category's own parts first (none today — seed attaches to children),
    // then its children's, in rank order.
    const inCategory = [
      ...(byGroup.get(topPath) ?? []),
      ...parts.filter((p) => p.parentCategorySlug === category.slug),
    ];
    routes.push({
      urlPath: topPath,
      file: `category/${category.slug}/index.html`,
      seo,
      body: {
        breadcrumb: [homeCrumb],
        heading: category.name,
        paragraphs: [
          seo.description,
          manufacturersSentence(category.name, inCategory),
        ].filter((p): p is string => p != null),
        sections: [
          { title: `${category.name} subcategories`, links: childLinks },
          {
            title: `${category.name} parts`,
            links: inCategory.slice(0, PART_LINKS_PER_LIST).map(partLink),
          },
        ],
      },
    });

    for (const child of children) {
      const childPath = `${topPath}/${child.slug}`;
      const childSeo = categorySeo({
        name: child.name,
        canonicalPath: childPath,
        description: child.description ?? null,
        parent: { name: category.name, slug: category.slug },
      });
      const ranked = byGroup.get(childPath) ?? [];
      // Prerendered parts first: each is a real Product document in the
      // sitemap. Only a subcategory with fewer than a screenful tops up from
      // the page-1 list the live page opens on — those serve the SPA shell,
      // but a subcategory with no link down at all is a crawl dead end.
      const seen = new Set<string>();
      const partLinks: BodyLink[] = [];
      for (const link of [...ranked.map(partLink), ...(child.parts ?? [])]) {
        if (partLinks.length >= PART_LINKS_PER_LIST) break;
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        partLinks.push(link);
      }
      routes.push({
        urlPath: childPath,
        file: `category/${category.slug}/${child.slug}/index.html`,
        seo: childSeo,
        body: {
          breadcrumb: [homeCrumb, { href: topPath, label: category.name }],
          heading: child.name,
          paragraphs: [childSeo.description, manufacturersSentence(child.name, ranked)].filter(
            (p): p is string => p != null,
          ),
          sections: [
            { title: `${child.name} parts`, links: partLinks },
            {
              title: `More in ${category.name}`,
              links: childLinks.filter((l) => l.href !== childPath),
            },
          ],
        },
      });
    }
  }

  // Already capped and ranked by the manifest generator — this loop writes
  // whatever it is given and does no selection of its own, so the policy has
  // exactly one home. Only parts WITH a slug are here (the manifest drops the
  // rest), since /part/<uuid> canonicalizes to the slug form anyway —
  // prerendering both shapes would emit two documents that disagree about
  // which is canonical.
  const indexInGroup = new Map<string, number>();
  for (const group of byGroup.values()) group.forEach((p, i) => indexInGroup.set(p.slug, i));

  for (const part of parts) {
    const groupPath = groupKey(part);
    const seo = partSeo({
      sku: part.sku,
      manufacturerName: part.manufacturerName ?? '',
      slug: part.slug,
      description: part.description ?? null,
      categoryName: part.categoryName ?? null,
      bestPrice: part.bestPrice ?? null,
      categoryPath: groupPath,
    });
    const categoryName = (groupPath && nameByPath.get(groupPath)) ?? part.categoryName ?? null;
    const crumbs: SeoLink[] = [homeCrumb];
    if (part.parentCategorySlug) {
      const parentPath = `/category/${part.parentCategorySlug}`;
      const parentName = nameByPath.get(parentPath);
      if (parentName) crumbs.push({ href: parentPath, label: parentName });
    }
    if (groupPath && categoryName) crumbs.push({ href: groupPath, label: categoryName });

    const group = groupPath ? byGroup.get(groupPath) ?? [] : [];
    const siblings = groupPath ? partTreeLinks(group, indexInGroup.get(part.slug) ?? 0) : [];
    const facts = [
      part.manufacturerName ? `Manufacturer: ${part.manufacturerName}.` : null,
      categoryName ? `Category: ${categoryName}.` : null,
      'Compare distributor prices and stock on Circuit Center.',
    ]
      .filter(Boolean)
      .join(' ');
    routes.push({
      urlPath: `/part/${part.slug}`,
      file: `part/${part.slug}/index.html`,
      seo,
      body: {
        breadcrumb: crumbs,
        heading: part.sku,
        paragraphs: [part.description, facts].filter((p): p is string => !!p),
        sections: [
          {
            title: categoryName ? `More ${categoryName}` : '',
            links: siblings.map(partLink),
          },
        ],
      },
    });
  }

  return routes;
}

// ── Sitemaps ────────────────────────────────────────────────────────────────
// A <urlset> may carry at most 50,000 URLs (sitemaps.org). 45,000 leaves
// headroom, so a manifest that grows adds a page instead of breaching the cap —
// the single 312,634-URL document of 2026-09-01 was rejected whole.
export const SITEMAP_PARTS_PAGE_SIZE = 45_000;

/** One sitemap document, relative to dist/. */
export interface SitemapFile {
  file: string;
  xml: string;
}

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// <lastmod> is the day the manifest was generated — the only honest date a
// snapshot has. The API stamped TODAY on every fetch, which claims a change
// whether or not one happened, and Google ignores a lastmod it cannot trust.
// An absent or malformed generatedAt emits no <lastmod> at all.
function lastmodOf(generatedAt: string | undefined): string | null {
  return /^(\d{4}-\d{2}-\d{2})T/.exec(generatedAt ?? '')?.[1] ?? null;
}

/**
 * The sitemap index plus one sitemap-parts-{n}.xml per `pageSize` part
 * documents, derived from the routes this build writes — never from a second
 * list — so a part URL is advertised if and only if its document exists.
 *
 * With no part routes the index names /sitemap-core.xml alone and no parts
 * page is written: a page that exists only to be empty is a 200 a crawler
 * keeps re-fetching for nothing.
 */
export function buildSitemaps(
  routes: PrerenderRoute[],
  generatedAt?: string,
  pageSize: number = SITEMAP_PARTS_PAGE_SIZE,
): SitemapFile[] {
  const lastmod = lastmodOf(generatedAt);
  const lastmodTag = lastmod ? `<lastmod>${lastmod}</lastmod>` : '';

  const partLocs = [
    ...new Set(routes.filter((r) => r.urlPath.startsWith('/part/')).map((r) => r.urlPath)),
  ].map((urlPath) => `${SITE_ORIGIN}${urlPath}`);

  const pages: SitemapFile[] = [];
  for (let i = 0; i < partLocs.length; i += pageSize) {
    const entries = partLocs
      .slice(i, i + pageSize)
      .map(
        (loc) =>
          `<url><loc>${escapeXml(loc)}</loc>${lastmodTag}` +
          `<changefreq>weekly</changefreq><priority>0.6</priority></url>`,
      );
    pages.push({
      file: `sitemap-parts-${pages.length + 1}.xml`,
      xml:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="${SITEMAP_NS}">\n${entries.join('\n')}\n</urlset>\n`,
    });
  }

  // The core child is rendered live by the API (static pages + categories), so
  // this build cannot know when it last changed — it gets no <lastmod> rather
  // than an invented one. The parts pages are this build's own output.
  const children = [
    `<sitemap><loc>${SITE_ORIGIN}/sitemap-core.xml</loc></sitemap>`,
    ...pages.map(
      (page) =>
        `<sitemap><loc>${escapeXml(`${SITE_ORIGIN}/${page.file}`)}</loc>${lastmodTag}</sitemap>`,
    ),
  ];
  const index: SitemapFile = {
    file: 'sitemap.xml',
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="${SITEMAP_NS}">\n${children.join('\n')}\n</sitemapindex>\n`,
  };
  return [index, ...pages];
}

export interface PrerenderLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PrerenderResult {
  routes: PrerenderRoute[];
  sitemaps: SitemapFile[];
}

/**
 * Writes every prerendered document AND the sitemaps into `outDir`. The Vite
 * plugin below is a thin wrapper, so a test can run the real writer against a
 * temp directory. Returns null — having written nothing, sitemaps included —
 * when there is no built shell to rewrite.
 */
export function writePrerender(
  options: { manifestPath: string; outDir: string },
  log: PrerenderLog,
): PrerenderResult | null {
  const outDir = options.outDir;
  const shellPath = path.join(outDir, 'index.html');
  if (!existsSync(shellPath)) return null;

  const shell = readFileSync(shellPath, 'utf8');
  const manifest = readManifest(options.manifestPath);
  if (!manifest) {
    log.warn(
      `[seo-prerender] ${path.basename(options.manifestPath)} missing or unreadable — ` +
        `category routes will fall back to the generic shell. ` +
        `Run \`node scripts/gen-seo-manifest.mjs\` against a running API.`,
    );
  }

  const routes = buildRoutes(manifest);
  for (const route of routes) {
    const dest = path.join(outDir, route.file);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, renderRoute(shell, route), 'utf8');
  }
  const sitemaps = buildSitemaps(routes, manifest?.generatedAt);
  for (const sitemap of sitemaps) {
    writeFileSync(path.join(outDir, sitemap.file), sitemap.xml, 'utf8');
  }

  // Broken down by type because the part count is the one that can silently
  // collapse: a manifest regenerated against an API without the capped-slice
  // endpoint would still emit a plausible-looking total made of categories.
  const parts = routes.filter((r) => r.urlPath.startsWith('/part/')).length;
  const categories = routes.filter((r) => r.urlPath.startsWith('/category/')).length;
  log.info(
    `[seo-prerender] wrote ${routes.length} indexable HTML documents ` +
      `(${routes.length - parts - categories} static, ${categories} category, ${parts} part) ` +
      `+ ${sitemaps.length} sitemap files advertising those ${parts} part URLs ` +
      `(manifest generated ${manifest?.generatedAt ?? 'never'})`,
  );
  return { routes, sitemaps };
}

export function seoPrerender(options: { manifestPath: string; outDir: string }): Plugin {
  return {
    name: 'circuits-seo-prerender',
    apply: 'build',
    // closeBundle, not writeBundle: dist/index.html must already be on disk,
    // and the PWA plugin precaches nothing (globPatterns: []) so ordering
    // against it does not matter.
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        writePrerender(options, {
          info: (message) => this.info(message),
          warn: (message) => this.warn(message),
        });
      },
    },
  };
}
