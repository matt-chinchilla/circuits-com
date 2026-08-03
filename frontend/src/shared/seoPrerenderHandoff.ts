// Hands the head over from the build-time prerender to react-helmet-async.
//
// scripts/seoPrerender.ts bakes a canonical, a robots meta, a description and
// the JSON-LD graphs into each templated route's static HTML so crawlers get
// them without running JS. Once the SPA boots, <PageHead> renders the SAME tags
// through helmet — and on React 19 helmet no longer reconciles against tags
// already in the document: its React19Dispatcher renders real <meta>/<link>/
// <script> elements and leans on React's native metadata hoisting, which
// APPENDS rather than replaces. Left alone that ships two canonicals per page,
// which is worse than the one-canonical-per-page state this whole feature
// exists to reach (Google discards a page's canonical signal when it conflicts).
//
// So the prerendered tags carry `data-seo-prerendered` and are removed here,
// once, before the first React render. A crawler that does not execute JS never
// reaches this code and keeps the static tags; one that does gets helmet's,
// which are built from the same PageSeo. Nothing else in the head is touched —
// og:*/twitter:* have no helmet counterpart and must survive.

const PRERENDERED_TAG_SELECTOR = '[data-seo-prerendered]';

export function dropPrerenderedSeoTags(doc: Document = document): number {
  const tags = doc.head?.querySelectorAll(PRERENDERED_TAG_SELECTOR);
  if (!tags) return 0;
  for (const tag of Array.from(tags)) tag.remove();
  return tags.length;
}
