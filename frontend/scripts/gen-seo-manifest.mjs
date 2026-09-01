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
// is otherwise several hundred KB per category and none of it is used here, and
// the part LINKS below come from a different endpoint (see childPartLinks).
async function childDescription(slug) {
  const detail = await getJson(
    `${API_BASE}/categories/${slug}/?parts_per_page=1&popular_per_page=1`,
  );
  return detail.description ?? null;
}

/** How many parts a subcategory links to — one screenful, matching page 1. */
const PART_LINKS_PER_SUBCATEGORY = 25;

/**
 * Page-1 part links for ONE subcategory — the reason part pages are reachable.
 *
 * Every part URL used to be a crawl orphan: the prerendered subcategory
 * document links only UPWARD (home + parent), because the parts themselves are
 * fetched and rendered by JS that a crawler reading raw HTML never runs. So the
 * static site had no path from home to any of the ~15,000 prerendered part
 * documents — they were reachable only through the sitemap. These links close
 * that gap: home -> category -> subcategory -> part, all in served HTML.
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
 * Only slug/sku/manufacturer are read, and only the rendered href+label are
 * kept: the manifest is committed, and the full rows would add megabytes of
 * prices and descriptions that the noscript link list never reads.
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
    links.push({
      href: `/part/${part.slug}`,
      label: part.manufacturer_name ? `${part.sku} — ${part.manufacturer_name}` : part.sku,
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
 * the last regen. The sitemap advertises exactly the same capped ranked slice
 * (/api/sitemap-parts-{n}.xml shares the _ranked_parts query), so one knob —
 * PRERENDER_PART_LIMIT — moves both surfaces together.
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
      parts: await childPartLinks(child.id),
    })),
  })),
  parts: await fetchParts(),
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const childCount = manifest.categories.reduce((n, c) => n + c.children.length, 0);
const children = manifest.categories.flatMap((c) => c.children);
const partLinkCount = children.reduce((n, c) => n + c.parts.length, 0);
// A subcategory with zero part links is the orphan symptom coming back, and it
// looks identical to a genuinely empty subcategory in the file itself.
const emptyChildren = children.filter((c) => c.parts.length === 0).length;
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
    `  part links:    ${partLinkCount} across subcategories` +
    (emptyChildren ? ` (${emptyChildren} with NONE)` : '') +
    `\n` +
    `  parts:         ${manifest.parts.length}${partNote}`,
);
