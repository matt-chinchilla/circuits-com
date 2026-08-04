import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ID,
  ORGANIZATION_JSONLD,
  SITE_ORIGIN,
  WEBSITE_ID,
  homeSeo,
  type PageSeo,
} from './seo';
import { STATIC_PAGE_SEO, categorySeo, partSeo } from './seoRoutes';

const org = JSON.parse(ORGANIZATION_JSONLD) as Record<string, unknown>;

describe('Organization JSON-LD', () => {
  it('is a schema.org Organization with a stable @id', () => {
    expect(org['@context']).toBe('https://schema.org');
    expect(org['@type']).toBe('Organization');
    expect(org['@id']).toBe(ORGANIZATION_ID);
  });

  it('carries the brand-term properties', () => {
    expect(org.name).toBe('Circuit Center');
    expect(org.url).toBe(`${SITE_ORIGIN}/`);
    expect(typeof org.description).toBe('string');
    expect((org.description as string).length).toBeGreaterThan(50);
  });

  it('points logo at an absolute, crawlable raster', () => {
    const logo = org.logo as string;
    expect(logo.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    // Google's Organization logo must be a raster >= 112x112. Only the
    // 180px apple-touch-icon in the favicon ladder clears that floor.
    expect(logo).toMatch(/\.(png|jpe?g|gif|webp)$/);
    expect(logo).not.toMatch(/\.svg$/);
  });

  it('omits sameAs until real profile URLs exist', () => {
    // A sameAs pointing at profiles that don't exist is worse than none —
    // it breaks entity resolution instead of helping it.
    expect(org).not.toHaveProperty('sameAs');
  });

  it('emits no null-valued properties', () => {
    // JSON-LD consumers reject null values; every optional property must be
    // absent rather than present-and-null.
    expect(Object.values(org).every((v) => v !== null)).toBe(true);
  });
});

describe('node ids', () => {
  it('are fragments off the origin so they cannot collide with page URLs', () => {
    expect(ORGANIZATION_ID).toBe(`${SITE_ORIGIN}/#organization`);
    expect(WEBSITE_ID).toBe(`${SITE_ORIGIN}/#website`);
    expect(ORGANIZATION_ID).not.toBe(WEBSITE_ID);
  });
});

// ─── Per-route head model ────────────────────────────────────────────────────
// These builders are the single source for BOTH the runtime <PageHead> and the
// build-time prerender (scripts/seoPrerender.ts). The P0 defect they exist to
// prevent is every URL serving one byte-identical head, so the properties
// asserted here are "differs per route" and "is a valid absolute canonical".

const PMIC = categorySeo({
  name: 'Power Management ICs (PMICs)',
  canonicalPath: '/category/power-management-ics-pmics',
  description: 'Curated PMIC copy from the categories table, the way the 15 top-level rows carry it.',
});

const LDO = categorySeo({
  name: 'Voltage Regulators (LDOs)',
  canonicalPath: '/category/power-management-ics-pmics/ldo-regulators',
  description: null,
  parent: { name: 'Power Management ICs (PMICs)', slug: 'power-management-ics-pmics' },
});

const PART = partSeo({
  sku: 'ADP151AUJZ-3.3',
  manufacturerName: 'Analog Devices',
  slug: 'adp151aujz-3-3',
  description: 'Ultra-low-noise 200 mA CMOS linear regulator in a TSOT package.',
  categoryName: 'Voltage Regulators (LDOs)',
  bestPrice: 1.234,
  categoryPath: '/category/power-management-ics-pmics/ldo-regulators',
});

function allRoutes(): PageSeo[] {
  return [homeSeo(), ...Object.values(STATIC_PAGE_SEO), PMIC, LDO, PART];
}

describe('page head model', () => {
  it('gives every route a distinct title and description', () => {
    const routes = allRoutes();
    // /terms reuses the privacy PageSeo by design, so the set is compared
    // against the number of DISTINCT PageSeo objects, not the number of URLs.
    expect(new Set(routes.map((r) => r.title)).size).toBe(routes.length);
    expect(new Set(routes.map((r) => r.description)).size).toBe(routes.length);
    expect(routes.every((r) => r.description.length > 40)).toBe(true);
  });

  it('emits absolute canonicals on every indexable route', () => {
    for (const route of allRoutes()) {
      if (route.canonical === null) {
        // The only canonical-less route is the noindex one; a missing canonical
        // anywhere else would re-open the duplicate-shell problem.
        expect(route.robots).toContain('noindex');
        continue;
      }
      expect(route.canonical.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
      expect(() => new URL(route.canonical as string)).not.toThrow();
    }
  });

  it('keeps search out of the index', () => {
    expect(STATIC_PAGE_SEO.search.robots).toBe('noindex, follow');
    expect(STATIC_PAGE_SEO.search.canonical).toBeNull();
  });

  it('carries parseable JSON-LD with no null-valued properties', () => {
    for (const route of allRoutes()) {
      for (const raw of route.jsonLd) {
        const node = JSON.parse(raw) as Record<string, unknown>;
        expect(node['@context']).toBe('https://schema.org');
        expect(Object.values(node).every((v) => v !== null)).toBe(true);
      }
    }
  });
});

describe('categorySeo', () => {
  it('canonicalises a subcategory to its nested URL', () => {
    expect(LDO.canonical).toBe(
      `${SITE_ORIGIN}/category/power-management-ics-pmics/ldo-regulators`,
    );
  });

  it('uses the curated description when the row has one', () => {
    expect(PMIC.description).toBe('Curated PMIC copy from the categories table, the way the 15 top-level rows carry it.');
    expect(JSON.parse(PMIC.jsonLd[0]).description).toBe(PMIC.description);
  });

  it('falls back to a named template when it does not', () => {
    expect(LDO.description).toContain('Voltage Regulators (LDOs)');
  });

  it('gives a subcategory a three-rung breadcrumb and a top-level two', () => {
    const sub = JSON.parse(LDO.jsonLd[1]) as { itemListElement: unknown[] };
    const top = JSON.parse(PMIC.jsonLd[1]) as { itemListElement: unknown[] };
    expect(sub.itemListElement).toHaveLength(3);
    expect(top.itemListElement).toHaveLength(2);
  });

  it('links the parent and children so a no-JS crawler can walk the tree', () => {
    const withChildren = categorySeo({
      name: 'Power Management ICs (PMICs)',
      canonicalPath: '/category/power-management-ics-pmics',
      children: [{ href: '/category/power-management-ics-pmics/ldo-regulators', label: 'LDOs' }],
    });
    expect(withChildren.links.map((l) => l.href)).toContain(
      '/category/power-management-ics-pmics/ldo-regulators',
    );
    expect(LDO.links.map((l) => l.href)).toContain('/category/power-management-ics-pmics');
  });
});

describe('homeSeo', () => {
  it('carries the Organization and WebSite nodes and nothing else', () => {
    const types = homeSeo().jsonLd.map((j) => JSON.parse(j)['@type']);
    expect(types).toEqual(['Organization', 'WebSite']);
  });

  it('exposes the top-level categories as crawlable links', () => {
    const seo = homeSeo([{ href: '/category/analog-ics', label: 'Analog ICs' }]);
    expect(seo.links[0]).toEqual({ href: '/category/analog-ics', label: 'Analog ICs' });
  });
});

describe('partSeo', () => {
  it('canonicalises to the slug URL, not the uuid the sitemap advertises', () => {
    // Known gap: internal links and the sitemap use /part/{uuid} while the page
    // canonicalises to /part/{slug}. Unifying them is the prerequisite for
    // prerendering part pages at all — see vite.config.ts.
    expect(PART.canonical).toBe(`${SITE_ORIGIN}/part/adp151aujz-3-3`);
  });

  it('builds a single-string title', () => {
    // react-helmet-async on React 19 renders a real <title> element, and React
    // silently drops one given multiple children — which is how every part page
    // shipped an EMPTY title until this builder landed.
    expect(PART.title).toBe(
      'ADP151AUJZ-3.3 by Analog Devices — Buy from Distributors | Circuit Center',
    );
  });

  it('quotes the best price when there is one', () => {
    expect(PART.description).toContain('Best price: $1.23');
    expect(
      partSeo({ sku: 'X', manufacturerName: 'Y', slug: 'x', bestPrice: null }).description,
    ).not.toContain('Best price');
  });

  it('withholds Product.offers while the prices are synthetic', () => {
    const product = JSON.parse(PART.jsonLd[0]) as Record<string, unknown>;
    expect(product['@type']).toBe('Product');
    expect(product).not.toHaveProperty('offers');
    expect(product.mpn).toBe('ADP151AUJZ-3.3');
  });
});
