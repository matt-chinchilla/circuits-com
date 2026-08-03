// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { dropPrerenderedSeoTags } from './seoPrerenderHandoff';

function seedHead(html: string) {
  document.head.innerHTML = html;
}

describe('dropPrerenderedSeoTags', () => {
  it('removes exactly the tags the prerender marked', () => {
    seedHead(`
      <link data-seo-prerendered rel="canonical" href="https://circuitcenter.ai/about">
      <meta data-seo-prerendered name="description" content="prerendered">
      <script data-seo-prerendered type="application/ld+json">{"@type":"CollectionPage"}</script>
    `);

    expect(dropPrerenderedSeoTags()).toBe(3);
    expect(document.head.querySelector('link[rel=canonical]')).toBeNull();
    expect(document.head.querySelector('meta[name=description]')).toBeNull();
    expect(document.head.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('leaves the Open Graph and Twitter tags alone', () => {
    // <PageHead> renders no counterpart for these, so stripping them would
    // delete the only copy the page has.
    seedHead(`
      <meta property="og:title" content="About Circuit Center">
      <meta property="og:url" content="https://circuitcenter.ai/about">
      <meta name="twitter:title" content="About Circuit Center">
      <link data-seo-prerendered rel="canonical" href="https://circuitcenter.ai/about">
    `);

    dropPrerenderedSeoTags();

    expect(document.head.querySelectorAll('meta[property^="og:"]')).toHaveLength(2);
    expect(document.head.querySelectorAll('meta[name^="twitter:"]')).toHaveLength(1);
  });

  it('is a no-op on an un-prerendered route', () => {
    // Part pages and keyword profiles still fall back to the generic shell,
    // which carries no marked tags.
    seedHead('<meta name="description" content="generic shell copy">');
    expect(dropPrerenderedSeoTags()).toBe(0);
    expect(document.head.querySelector('meta[name=description]')).not.toBeNull();
  });
});
