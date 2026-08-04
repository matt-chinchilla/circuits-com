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
// This module and its sibling ./seoRoutes are imported by TWO consumers that
// must never disagree:
//   1. <PageHead> — react-helmet-async, running in the browser after mount.
//   2. scripts/seoPrerender.ts — the build-time step that bakes the same head
//      into a static HTML file per route (see vite.config.ts).
// A crawler that does not run JS reads (2); a browser ends up with (1). If the
// two were built from separate literals they would drift silently and the raw
// HTML would advertise metadata the rendered page contradicts, so every field
// a route needs comes from a builder below and nowhere else.
//
// Only the home-page half lives here — HomePage is eagerly imported for LCP, so
// everything this file exports ships in the entry chunk. The nine lazy routes'
// head models live in ./seoRoutes.
//
// Keep both files free of React and of `@`-alias imports: vite.config.ts pulls
// them in through esbuild, where neither is resolvable.
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

/** Site-wide links for the no-JS fallback bodies. */
export const SITE_LINKS: SeoLink[] = [
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
