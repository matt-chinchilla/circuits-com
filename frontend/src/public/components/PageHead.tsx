import { Helmet } from 'react-helmet-async';
import type { PageSeo } from '@public/services/seo';

/**
 * Renders a route's head from the SAME PageSeo the build-time prerender bakes
 * into that route's static HTML (scripts/seoPrerender.ts).
 *
 * helmet on React 19 APPENDS these tags rather than reconciling against the
 * prerendered ones, so the prerendered copies are stripped in main.tsx before
 * the first render — see @shared/seoPrerenderHandoff. Anything added here must
 * therefore either be marked in seoPrerender.ts too or be absent from it, or
 * the page ships two of it.
 */
export default function PageHead({ seo }: { seo: PageSeo }) {
  return (
    <Helmet>
      <title>{seo.title}</title>
      <meta name="description" content={seo.description} />
      {seo.robots ? <meta name="robots" content={seo.robots} /> : null}
      {seo.canonical ? <link rel="canonical" href={seo.canonical} /> : null}
      {seo.jsonLd.map((json, i) => (
        <script key={i} type="application/ld+json">
          {json}
        </script>
      ))}
    </Helmet>
  );
}
