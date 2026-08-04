#!/usr/bin/env node
// Regenerates frontend/seo-manifest.json — the category snapshot the build-time
// SEO prerender (scripts/seoPrerender.ts) turns into 90 indexable category
// documents.
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
 * Every part, paged out of the list endpoint.
 *
 * Parts are ~97% of the sitemap, so leaving them out of the manifest left the
 * overwhelming majority of the site on the generic shell. Only the fields
 * `partSeo` reads are kept — the full payload carries listings and price
 * breaks, which would bloat a committed file by two orders of magnitude for
 * data no head tag uses.
 *
 * `description` is truncated here rather than at render: it only ever reaches
 * a meta description, which search engines cut around 160 chars anyway, and
 * the untruncated copy across 3,600 parts is most of the file size.
 */
async function fetchParts() {
  // /api/parts/ caps per_page at 100 (le=100 in the route); the 500 ceiling
  // belongs to the CATEGORY endpoint, not this one.
  const perPage = 100;
  const parts = [];
  for (let page = 1; ; page += 1) {
    const payload = await getJson(`${API_BASE}/parts/?page=${page}&per_page=${perPage}`);
    const batch = payload.parts ?? payload.items ?? [];
    for (const p of batch) {
      if (!p.slug) continue; // no slug, no stable URL to prerender
      parts.push({
        slug: p.slug,
        sku: p.sku,
        manufacturerName: p.manufacturer_name ?? null,
        description: (p.description ?? '').slice(0, 200) || null,
        categoryName: p.category_name ?? null,
        categorySlug: p.category_slug ?? null,
        parentCategorySlug: p.parent_category_slug ?? null,
        bestPrice: p.best_price ?? null,
      });
    }
    if (batch.length < perPage) break;
  }
  // Duplicate slugs are expected (same SKU, two manufacturers). One file per
  // URL: the first wins, matching what /parts/by-slug returns.
  const seen = new Set();
  return parts.filter((p) => !seen.has(p.slug) && seen.add(p.slug));
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
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ` +
    `${manifest.categories.length} categories + ${childCount} subcategories + ` +
    `${manifest.parts.length} parts (source ${API_BASE})`,
);
