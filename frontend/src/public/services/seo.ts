// Site-wide entity markup. Google resolves ONE Organization node per site and
// keys it by @id, so the node is defined here once and every other JSON-LD
// graph on the site references ORGANIZATION_ID instead of restating it.

export const SITE_ORIGIN = 'https://circuitcenter.ai';

// Node identifiers, not fetchable URLs — the fragment keeps them distinct from
// the crawlable page URLs they hang off, so a `{"@id": ...}` reference resolves
// to the entity rather than being read as a second copy of the page.
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

// Google requires Organization.logo to be a crawlable raster of at least
// 112x112 px. apple-touch-icon.png (180x180) is the largest raster the favicon
// ladder ships; the 48px rungs are below the floor and logo-mark.svg is a
// vector, so neither qualifies. Replacing this needs a new PNG >= 112px, not a
// swap to the SVG.
const ORGANIZATION_LOGO = `${SITE_ORIGIN}/images/apple-touch-icon.png`;

// sameAs is deliberately ABSENT: no verified Circuit Center social profiles
// exist yet. Pointing sameAs at accounts that don't exist (or aren't ours)
// actively damages entity resolution — it is worse than omitting the property.
// Add it only with real, confirmed profile URLs.
export const ORGANIZATION_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: 'Circuit Center',
  alternateName: 'CircuitCenter',
  url: `${SITE_ORIGIN}/`,
  logo: ORGANIZATION_LOGO,
  image: ORGANIZATION_LOGO,
  description:
    'Circuit Center is an electronic components directory. Compare prices and stock for integrated circuits, microcontrollers, sensors, and passives across authorized distributors, with datasheets and lifecycle status on every part.',
  foundingDate: '2003',
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-route head model
//
// This module is imported by TWO consumers that must never disagree:
//   1. <PageHead> — react-helmet-async, running in the browser after hydration.
//   2. scripts/seoPrerender.ts — the build-time step that bakes the same head
//      into a static HTML file per route (see vite.config.ts).
// A crawler that does not run JS reads (2); a browser ends up with (1). If the
// two were built from separate literals they would drift silently and the raw
// HTML would advertise metadata the rendered page contradicts, so every field
// a route needs comes from a builder below and nowhere else.
//
// Keep this file free of React and of `@`-alias imports: vite.config.ts pulls
// it in through esbuild, where neither is resolvable.
// ─────────────────────────────────────────────────────────────────────────────

/** A single crawler-visible link in the no-JS fallback body. */
export interface SeoLink {
  href: string;
  label: string;
}

export interface PageSeo {
  title: string;
  description: string;
  /** Absolute URL. null = emit no canonical (self-referential is correct). */
  canonical: string | null;
  /** Only set where it differs from the default index,follow. */
  robots?: string;
  /** Pre-stringified JSON-LD graphs, one per <script type="application/ld+json">. */
  jsonLd: string[];
  /**
   * Heading + links for the prerendered <noscript> body. A JS-enabled client
   * never parses this (the HTML parser keeps noscript content as raw text when
   * scripting is on), so it costs a JS visitor nothing and never competes with
   * the SPA's own <h1>.
   */
  heading: string;
  links: SeoLink[];
}

const SITE_LINKS: SeoLink[] = [
  { href: '/about', label: 'About Circuit Center' },
  { href: '/join', label: 'List your components' },
  { href: '/keyword', label: 'Keyword sponsorship' },
  { href: '/contact', label: 'Contact' },
];

const WEBSITE_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: 'Circuit Center',
  url: `${SITE_ORIGIN}/`,
  publisher: { '@id': ORGANIZATION_ID },
  potentialAction: {
    '@type': 'SearchAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: `${SITE_ORIGIN}/search?q={search_term_string}`,
    },
    'query-input': 'required name=search_term_string',
  },
});

/**
 * Home. The Organization node lives here only — Google reads one per site and
 * follows the @id references emitted by every other page's graph.
 *
 * @param categories top-level categories, when known. They become the no-JS
 *   fallback's link list, which is the ONLY path by which a crawler that does
 *   not execute JS can discover the category URLs from the home document.
 */
export function homeSeo(categories: SeoLink[] = []): PageSeo {
  return {
    title:
      'The Integrated Circuits Directory — Compare Prices & Distributors | Circuit Center',
    description:
      'Compare prices and stock for 3,600+ electronic components from 57 distributors. ICs, MCUs, sensors, and more.',
    canonical: `${SITE_ORIGIN}/`,
    jsonLd: [ORGANIZATION_JSONLD, WEBSITE_JSONLD],
    heading: 'Circuit Center — The Integrated Circuits Directory',
    links: [...categories, ...SITE_LINKS],
  };
}

export type StaticPageKey = 'about' | 'contact' | 'join' | 'keyword' | 'privacy' | 'search';

/**
 * Routes whose head is a fixed literal. `/terms` renders the same component as
 * `/privacy` and deliberately shares its canonical — the two URLs are one page.
 */
export const STATIC_PAGE_SEO: Record<StaticPageKey, PageSeo> = {
  about: {
    title: 'About Circuit Center — The Integrated Circuits Directory',
    description:
      'Learn about Circuit Center — the integrated circuits directory connecting buyers, suppliers, and engineers. Compare prices from 57 distributors.',
    canonical: `${SITE_ORIGIN}/about`,
    jsonLd: [],
    heading: 'About Circuit Center',
    links: SITE_LINKS,
  },
  contact: {
    title: 'Contact Circuit Center — Get in Touch',
    description:
      'Contact Circuit Center for questions about electronic component pricing, distributor listings, or partnership opportunities.',
    canonical: `${SITE_ORIGIN}/contact`,
    jsonLd: [],
    heading: 'Contact Us',
    links: SITE_LINKS,
  },
  join: {
    title: 'Join Circuit Center — List Your Components | Distributors Welcome',
    description:
      'List your electronic components on Circuit Center. Reach engineers and buyers searching for ICs, MCUs, sensors, and more from 57+ distributors.',
    canonical: `${SITE_ORIGIN}/join`,
    jsonLd: [],
    heading: 'Join Circuit Center',
    links: SITE_LINKS,
  },
  keyword: {
    title: 'Keyword Sponsorship — Promote Your Brand | Circuit Center',
    description:
      'Sponsor a keyword on Circuit Center. Own the search term your buyers type — one sponsor per keyword, live in 48 hours, month-to-month.',
    canonical: `${SITE_ORIGIN}/keyword`,
    jsonLd: [],
    heading: 'Sponsor a Keyword',
    links: SITE_LINKS,
  },
  privacy: {
    title: 'Privacy Policy | Circuit Center',
    description:
      'Circuit Center privacy policy — how we handle your data, cookies, and third-party services.',
    canonical: `${SITE_ORIGIN}/privacy`,
    jsonLd: [],
    heading: 'Privacy Policy',
    links: SITE_LINKS,
  },
  // Result pages are noindex,follow: the query space is unbounded and every
  // URL in it is a near-duplicate of the category pages it links to.
  search: {
    title: 'Search Electronic Components | Circuit Center',
    description:
      'Search 3,600+ electronic components across 57 distributors by part number, manufacturer, or category.',
    canonical: null,
    robots: 'noindex, follow',
    jsonLd: [],
    heading: 'Search',
    links: SITE_LINKS,
  },
};

export interface CategorySeoInput {
  name: string;
  /** Root-relative canonical path from `categoryPath(slug, parentSlug)`. */
  canonicalPath: string;
  description?: string | null;
  parent?: { name: string; slug: string } | null;
  /** Subcategories, for the no-JS fallback's link list. */
  children?: SeoLink[];
}

export function categorySeo(input: CategorySeoInput): PageSeo {
  const url = `${SITE_ORIGIN}${input.canonicalPath}`;
  // Subcategories carry no curated description (only the 15 top-level rows do),
  // so the template below IS the shipped meta description for 75 of the 90
  // category URLs. `??` and not `||` on purpose: an empty string from the API
  // would be a data bug worth surfacing, not something to paper over.
  const description =
    input.description ??
    `Compare prices for ${input.name} components from top distributors on Circuit Center.`;

  const collectionPage = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: input.name,
    description,
    url,
    isPartOf: { '@id': WEBSITE_ID },
    publisher: { '@id': ORGANIZATION_ID },
  };

  // Emitted for top-level categories too (Home > Category), not just
  // subcategories — the rendered breadcrumb has always had two rungs there and
  // the markup has to agree with it.
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_ORIGIN}/` },
      ...(input.parent
        ? [
            {
              '@type': 'ListItem',
              position: 2,
              name: input.parent.name,
              item: `${SITE_ORIGIN}/category/${input.parent.slug}`,
            },
          ]
        : []),
      {
        '@type': 'ListItem',
        position: input.parent ? 3 : 2,
        name: input.name,
        item: url,
      },
    ],
  };

  return {
    title: `${input.name} — Prices & Distributors | Circuit Center`,
    description,
    canonical: url,
    jsonLd: [JSON.stringify(collectionPage), JSON.stringify(breadcrumb)],
    heading: input.name,
    links: [
      { href: '/', label: 'Circuit Center' },
      ...(input.parent
        ? [{ href: `/category/${input.parent.slug}`, label: input.parent.name }]
        : []),
      ...(input.children ?? []),
    ],
  };
}
