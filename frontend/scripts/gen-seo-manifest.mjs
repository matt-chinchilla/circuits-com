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
// its own detail call. parts/popular page sizes are pinned to 1 — the payload
// is otherwise several hundred KB per category and none of it is used here.
async function childDescription(slug) {
  const detail = await getJson(
    `${API_BASE}/categories/${slug}/?parts_per_page=1&popular_per_page=1`,
  );
  return detail.description ?? null;
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
 * the last regen. The dynamic /api/sitemap.xml stays FULL; the cap bounds what
 * ships as static HTML, never what is advertised to crawlers.
 *
 * The ranking lives server-side because it needs a SUM over part_listings that
 * no public list endpoint exposes, and paging 270k rows through /api/parts/
 * would be ~2,700 requests of data the head tags never read.
 *
 * Only the fields `partSeo` reads are kept. `description` is truncated here
 * rather than at render: it only ever reaches a meta description, which search
 * engines cut around 160 chars anyway, and the untruncated copy is most of the
 * file size.
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

const manifest = {
  generatedAt: new Date().toISOString(),
  source: API_BASE,
  categories: await mapWithConcurrency(topLevel, 4, async (category) => ({
    slug: category.slug,
    name: category.name,
    description: category.description ?? null,
    children: await mapWithConcurrency(category.children ?? [], 4, async (child) => ({
      slug: child.slug,
      name: child.name,
      description: await childDescription(child.slug),
    })),
  })),
  parts: await fetchParts(),
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const childCount = manifest.categories.reduce((n, c) => n + c.children.length, 0);
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
    `  parts:         ${manifest.parts.length}${partNote}`,
);
