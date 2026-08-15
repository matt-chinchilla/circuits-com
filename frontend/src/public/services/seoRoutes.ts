// Head models for the routes that are NOT on the eager home-page path.
//
// Split out of ./seo so it stays out of the entry chunk: HomePage is eagerly
// imported for LCP, so anything ./seo exports ships to every first paint, while
// every consumer below (category, part, about, contact, join, keyword, privacy,
// search) is behind a lazy route. Rollup hoists a module shared by an eager and
// a lazy chunk into the entry, so these literals have to live in their own file
// to stay off the critical path. scripts/seoPrerender.ts imports both.

import {
  ORGANIZATION_ID,
  SITE_LINKS,
  SITE_ORIGIN,
  WEBSITE_ID,
  type PageSeo,
  type SeoLink,
} from './seo';

export type StaticPageKey =
  | 'about'
  | 'acceptableUse'
  | 'contact'
  | 'join'
  | 'keyword'
  | 'privacy'
  | 'search'
  | 'terms';

/**
 * Routes whose head is a fixed literal.
 *
 * `/terms` used to render the privacy policy and share its canonical. It is a
 * real document as of 2026-08-05 with its own canonical, so the two are now
 * separate entries — do not re-merge them.
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
  acceptableUse: {
    title: 'Acceptable Use Policy | Circuit Center',
    description:
      'What may be advertised on Circuit Center — prohibited content, supply-chain integrity rules for component advertisers, and how we enforce them.',
    canonical: `${SITE_ORIGIN}/acceptable-use`,
    jsonLd: [],
    heading: 'Acceptable Use Policy',
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
  // /join absorbed /pricing (nav "Advertise") on 2026-08-14 — one page now
  // answers "what do I get and what does it cost", so the description carries
  // the real ladder rather than the old listing-only pitch.
  join: {
    title: 'Join Circuit Center — Get Listed & Advertise | Sponsorship Tiers',
    description:
      'List your components on Circuit Center and sponsor the boards buyers browse: Silver $100/mo self-serve, Gold $600 and Platinum $2,400 through the partners desk.',
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
  terms: {
    title: 'Terms of Service | Circuit Center',
    description:
      'Circuit Center terms of service — sponsorship placements, billing and tax, cancellation and refunds, and the limits of our directory data.',
    canonical: `${SITE_ORIGIN}/terms`,
    jsonLd: [],
    heading: 'Terms of Service',
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

export interface PartSeoInput {
  sku: string;
  manufacturerName: string;
  /** Part.slug — non-unique by design; duplicate SKUs share one canonical. */
  slug: string;
  description?: string | null;
  categoryName?: string | null;
  bestPrice?: number | null;
  categoryPath?: string | null;
}

export function partSeo(input: PartSeoInput): PageSeo {
  const url = `${SITE_ORIGIN}/part/${input.slug}`;
  const price =
    input.bestPrice != null ? ` Best price: $${input.bestPrice.toFixed(2)}` : '';

  // `offers` is deliberately absent. The listing prices in this build are
  // synthetic demo data, and Google treats Product offers that disagree with
  // the real distributor price as deceptive markup (manual-action territory),
  // so the table stays visible-only until a live price feed backs it. Optional
  // properties are spread in rather than set to null — a JSON-LD property whose
  // value is null fails validation.
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.sku,
    url,
    // A Part row's SKU *is* the manufacturer part number — distributor-side
    // SKUs live on PartListing.sku — so it fills both properties.
    sku: input.sku,
    mpn: input.sku,
    brand: { '@type': 'Brand', name: input.manufacturerName },
    ...(input.description ? { description: input.description } : {}),
    ...(input.categoryName ? { category: input.categoryName } : {}),
  };

  return {
    title: `${input.sku} by ${input.manufacturerName} — Buy from Distributors | Circuit Center`,
    description: `${input.description || input.sku}. Compare prices from distributors.${price}`,
    canonical: url,
    jsonLd: [JSON.stringify(product)],
    heading: input.sku,
    links: [
      { href: '/', label: 'Circuit Center' },
      ...(input.categoryPath && input.categoryName
        ? [{ href: input.categoryPath, label: input.categoryName }]
        : []),
    ],
  };
}

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
