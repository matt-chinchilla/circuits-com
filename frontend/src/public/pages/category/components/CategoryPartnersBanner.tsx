import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '@public/services/api';
import { getPartnersMemo, setPartnersMemo } from '@shared/services/partnersMemo';
import CategorySponsor from './CategorySponsor';
import type { CategoryPartners } from '@public/types/category';

/**
 * Platinum Category Sponsor banner — a TOP-LEVEL-category artifact (identical on
 * the parent page and every subpage). Mounted inside CategoryPage's content area
 * (below the breadcrumb + sticky sub-nav, so the page nav stays on top), which
 * means it remounts on each subcategory nav.
 *
 * The board is ALWAYS present: when `platinum` is null the CategorySponsor falls
 * back to its Open-Placement state (drag-a-logo pitch + "Become a sponsor" CTA),
 * so there is no `length === 0 → null` guard anymore.
 *
 * To avoid a pop-in layout shift on every nav, the payload is read SYNCHRONOUSLY
 * from a session memo (partnersMemo) in the useState initializer: once a top-level
 * category has been fetched, navigating among its subcategories renders the banner
 * WITH data on the first frame — no null phase, no shift. The memo is cleared by
 * bustSponsorCaches() on any sponsor mutation, so it can't serve stale data.
 *
 * The first path segment after /category/ is the top-level slug in canonical URLs;
 * the endpoint resolves a child slug to its parent anyway, so a brief pre-redirect
 * flat-child URL still yields the correct banner.
 */
function topLevelSlug(pathname: string): string | null {
  const m = pathname.match(/^\/category\/([^/]+)/);
  return m ? m[1] : null;
}

export default function CategoryPartnersBanner() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const slug = topLevelSlug(pathname);
  const [data, setData] = useState<CategoryPartners | null>(() =>
    slug ? getPartnersMemo<CategoryPartners>(slug) ?? null : null,
  );

  useEffect(() => {
    if (!slug) return;
    // Warm memo (a sibling subcategory already fetched this top-level): use it
    // synchronously, no network. This is the no-layout-shift path.
    const cached = getPartnersMemo<CategoryPartners>(slug);
    if (cached) {
      setData(cached);
      return;
    }
    // Cold: clear any prior-category data, then fetch + memoize.
    let cancelled = false;
    setData(null);
    api
      .getCategoryPartners(slug)
      .then((d) => {
        if (cancelled) return;
        setPartnersMemo(slug, d);
        // Also memo under the RESOLVED top-level slug. A direct/bookmarked flat
        // child URL (/category/<child>) keys by the child slug, then canonically
        // redirects to /category/<parent>/<child> — without this second write
        // that remount misses the memo and the banner pops in a second time.
        if (d.slug !== slug) setPartnersMemo(d.slug, d);
        setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Open-Placement CTA → Contact page, prefilled with the category context (lands
  // as a Message). The Contact page reads location.state.prefillMessage.
  const handleSponsorCta = () => {
    const name = data?.name ?? 'this';
    navigate('/contact', {
      state: { prefillMessage: `I'd like to sponsor the ${name} category.` },
    });
  };

  // ALWAYS render the board (even with no slug yet / no data): it owns its
  // Open-Placement fallback, and the band height must stay stable across nav.
  return (
    <CategorySponsor
      sponsor={data?.platinum ?? null}
      categoryName={data?.name ?? 'this category'}
      slug={slug ?? data?.slug ?? ''}
      onNavigate={handleSponsorCta}
    />
  );
}
