#!/usr/bin/env node
// Regenerates frontend/seo-manifest.json — the route snapshot the build-time
// SEO prerender (scripts/seoPrerender.ts) turns into indexable HTML documents:
// every category and subcategory, plus a CAPPED, ranked slice of parts.
//
// It is a COMMITTED snapshot, not a build-time fetch, because the frontend
// Docker build stage has neither network access nor a database: `docker compose
// build frontend` only ever sees the frontend/ context. The taxonomy is seeded
// data that changes only on a reseed, so a snapshot is an honest model of it.
//
// Run it against any environment that serves the public API:
//   node scripts/gen-seo-manifest.mjs                       # http://localhost/api
//   node scripts/gen-seo-manifest.mjs https://circuitcenter.ai/api
//
// Drift is fail-open in both directions: a category present in the DB but
// missing here just falls back to the generic SPA shell (today's behaviour),
// and a category removed from the DB but still listed here prerenders a page
// the SPA will render as empty — the same outcome as any stale bookmark.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = (process.argv[2] ?? 'http://localhost/api').replace(/\/$/, '');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../seo-manifest.json');

async function getJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// The list endpoint omits `description` on children, so each subcategory needs
// its own detail call. It asks for the CANONICAL first page on purpose — the
// exact query index.html preloads and the api's category warmer keeps rendered
// (routes/categories.CANONICAL_PARAMS) — so each call is a process-cache hit
// (~0.1s on prod) instead of a fresh render of a 100k-part category. No
// trailing slash: FastAPI would 307 it first. The part LINKS come from
// elsewhere (see childPartLinks), because these part rows carry no slug.
const CANONICAL_CATEGORY_QUERY =
  'popular_page=1&popular_per_page=1&parts_page=1&parts_per_page=25';

async function childDescription(slug) {
  const detail = await getJson(`${API_BASE}/categories/${slug}?${CANONICAL_CATEGORY_QUERY}`);
  return detail.description ?? null;
}

/**
 * How many parts one list links to — one screenful, matching page 1. Mirrors
 * PART_LINKS_PER_LIST in scripts/seoPrerender.ts, which renders these.
 */
const PART_LINKS_PER_SUBCATEGORY = 25;

/**
 * Page-1 part links for ONE subcategory — the TOP-UP for a thin one.
 *
 * A subcategory document lists its own PRERENDERED parts first (the ranked
 * slice below, grouped by category in seoPrerender.ts): each is a real Product
 * document in the sitemap. That used to be these page-1 links alone, and on
 * 2026-09-22 only 341 of their 4,638 targets had a prerendered document — the
 * rest served the SPA shell, and 14,636 of 14,977 part documents had no
 * internal link at all. So these are now fetched only for a subcategory with
 * fewer than a screenful of ranked parts, where a crawl dead end would
 * otherwise be the alternative (~2.4s a call on prod, so skipping the rest
 * matters too).
 *
 * The rows come from /api/parts/ rather than the category detail call above
 * because the category detail's part items carry NO `slug` (see
 * category_service._build_public_parts — id, sku, prices, no slug), and the
 * prerender keys one document per part SLUG. Deriving the slug from the SKU
 * client-side would mirror `slugify_sku` in a second language with nothing
 * guarding the pair, and every drift would be a link to a 404. /api/parts/
 * hands back the stored slug, and its `Part.sku` ordering is the same ordering
 * a leaf category page opens on (`resolve_sort` defaults a leaf to sku asc), so
 * these are the parts a visitor actually sees on page 1.
 *
 * Only slug/sku/manufacturer are read, and only the rendered href/label/note
 * are kept: the manifest is committed, and the full rows would add megabytes of
 * prices and descriptions that the rendered link list never reads.
 */
async function childPartLinks(categoryId) {
  const payload = await getJson(
    `${API_BASE}/parts/?category_id=${encodeURIComponent(categoryId)}` +
      `&per_page=${PART_LINKS_PER_SUBCATEGORY}`,
  );
  const seen = new Set();
  const links = [];
  for (const part of payload.items ?? []) {
    // A part with no slug has no prerendered document and no slug URL to point
    // at; /part/<uuid> would resolve to the generic SPA shell for a crawler.
    if (!part.slug || seen.has(part.slug)) continue;
    seen.add(part.slug);
    // The anchor is the MPN alone, like the ranked links it sits beside; the
    // manufacturer rides as plain text after it.
    links.push({
      href: `/part/${part.slug}`,
      label: part.sku,
      ...(part.manufacturer_name ? { note: part.manufacturer_name } : {}),
    });
  }
  return links;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const categories = await getJson(`${API_BASE}/categories/`);
const topLevel = categories.filter((c) => Array.isArray(c.children));

/**
 * The CAPPED, ranked part slice — one request to /api/seo/prerender-parts.
 *
 * Parts are ~97% of the sitemap, so leaving them out of the manifest left the
 * overwhelming majority of the site on the generic shell. But the prerender
 * writes one FILE per route, and the catalog passed 270k parts: every part
 * would mean a multi-GB dist/ that no deploy can carry. The server therefore
 * hands back a hard-capped, ranked slice (photo AND price first, then stock
 * descending, then newest) and the rest of the catalog falls back to the SPA
 * shell + client-side helmet — already the behaviour of every part added since
 * the last regen. The build then writes sitemap-parts-{n}.xml from the very
 * part routes it prerenders out of THIS file (scripts/seoPrerender.ts), so the
 * sitemap advertises exactly this snapshot — regenerating is what moves both.
 * (Until 2026-09-22 the API ranked the sitemap live per fetch and it drifted
 * from the committed snapshot: 35% of sampled sitemap URLs served the shell.)
 *
 * The ranking lives server-side because it needs a SUM over part_listings that
 * no public list endpoint exposes, and paging 270k rows through /api/parts/
 * would be ~2,700 requests of data the head tags never read.
 *
 * Only the fields the prerender reads are kept. `description` is truncated here
 * rather than at render: it reaches a meta description (search engines cut
 * around 160 chars anyway) and an 80-char note beside the part's links, and
 * the untruncated copy is most of the file size.
 */
async function fetchParts() {
  const payload = await getJson(`${API_BASE}/seo/prerender-parts`);
  const parts = (payload.parts ?? []).map((p) => ({
    slug: p.slug,
    sku: p.sku,
    manufacturerName: p.manufacturer_name ?? null,
    description: (p.description ?? '').slice(0, 200) || null,
    categoryName: p.category_name ?? null,
    categorySlug: p.category_slug ?? null,
    parentCategorySlug: p.parent_category_slug ?? null,
    bestPrice: p.best_price ?? null,
  }));
  // Duplicate slugs are expected (same SKU, two manufacturers). One file per
  // URL: the first wins, matching what /parts/by-slug returns. Deduping AFTER
  // the cap means a duplicate costs a slot rather than promoting a lower-ranked
  // part — the shortfall is a handful of rows out of 15,000.
  const seen = new Set();
  return parts.filter((p) => !seen.has(p.slug) && seen.add(p.slug));
}

/** Total parts in the catalog, so the summary can say whether the cap bites. */
async function catalogPartTotal() {
  const payload = await getJson(`${API_BASE}/parts/?page=1&per_page=1`);
  return payload.total ?? null;
}

const generatedAt = new Date().toISOString();
const parts = await fetchParts();
// How many ranked parts each subcategory already has, keyed as the prerender
// groups them (parent/child slug pair).
const rankedPerChild = new Map();
for (const p of parts) {
  if (!p.parentCategorySlug || !p.categorySlug) continue;
  const key = `${p.parentCategorySlug}/${p.categorySlug}`;
  rankedPerChild.set(key, (rankedPerChild.get(key) ?? 0) + 1);
}

const manifest = {
  generatedAt,
  source: API_BASE,
  categories: await mapWithConcurrency(topLevel, 4, async (category) => ({
    slug: category.slug,
    name: category.name,
    description: category.description ?? null,
    children: await mapWithConcurrency(category.children ?? [], 4, async (child) => {
      const ranked = rankedPerChild.get(`${category.slug}/${child.slug}`) ?? 0;
      return {
        slug: child.slug,
        name: child.name,
        description: await childDescription(child.slug),
        ...(ranked < PART_LINKS_PER_SUBCATEGORY ? { parts: await childPartLinks(child.id) } : {}),
      };
    }),
  })),
  parts,
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const childCount = manifest.categories.reduce((n, c) => n + c.children.length, 0);
const children = manifest.categories.flatMap((c) => c.children);
const rankedKey = (category, child) => `${category.slug}/${child.slug}`;
const toppedUp = children.filter((c) => c.parts).length;
// A subcategory with zero part links of EITHER kind is the orphan symptom
// coming back, and it looks identical to a genuinely empty subcategory.
const emptyChildren = manifest.categories
  .flatMap((c) => c.children.map((child) => [c, child]))
  .filter(([c, child]) => !rankedPerChild.get(rankedKey(c, child)) && !(child.parts ?? []).length)
  .length;
const partTotal = await catalogPartTotal();
// Say plainly whether the cap is binding. A silently-capped manifest looks
// identical to a small catalog, and the difference is ~250k pages.
const partNote =
  partTotal != null && partTotal > manifest.parts.length
    ? ` (CAPPED — ${partTotal.toLocaleString('en-US')} in catalog; the rest serve the SPA shell)`
    : '';
console.log(
  `wrote ${path.relative(process.cwd(), OUT)} (source ${API_BASE})\n` +
    `  categories:    ${manifest.categories.length}\n` +
    `  subcategories: ${childCount}\n` +
    `  with ranked:   ${rankedPerChild.size} subcategories hold prerendered parts; ` +
    `${toppedUp} topped up from page 1` +
    (emptyChildren ? ` (${emptyChildren} with NO part links)` : '') +
    `\n` +
    `  parts:         ${manifest.parts.length}${partNote}`,
);
