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
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const childCount = manifest.categories.reduce((n, c) => n + c.children.length, 0);
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ` +
    `${manifest.categories.length} categories + ${childCount} subcategories (source ${API_BASE})`,
);
