import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '@public/services/api';
import { getPartnersMemo, setPartnersMemo } from '@shared/services/partnersMemo';
import PreferredPartnersBanner from './PreferredPartnersBanner';
import type { CategoryPartners } from '@public/types/category';

/**
 * Preferred Partners banner — a TOP-LEVEL-category artifact (identical on the
 * parent page and every subpage). Mounted inside CategoryPage's content area
 * (below the breadcrumb + sticky sub-nav, so the page nav stays on top), which
 * means it remounts on each subcategory nav.
 *
 * To avoid a pop-in layout shift on every nav, the partners payload is read
 * SYNCHRONOUSLY from a session memo (partnersMemo) in the useState initializer:
 * once a top-level category has been fetched, navigating among its subcategories
 * renders the banner WITH data on the first frame — no null phase, no shift. The
 * memo is cleared by bustSponsorCaches() on any sponsor mutation, so it can't
 * serve stale partners (preserves the single-source invariant).
 *
 * The first path segment after /category/ is the top-level slug in canonical
 * URLs; the endpoint resolves a child slug to its parent anyway, so a brief
 * pre-redirect flat-child URL still yields the correct banner.
 */
function topLevelSlug(pathname: string): string | null {
  const m = pathname.match(/^\/category\/([^/]+)/);
  return m ? m[1] : null;
}

export default function CategoryPartnersBanner() {
  const { pathname } = useLocation();
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
        setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!slug || !data || data.partners.length === 0) return null;
  return <PreferredPartnersBanner suppliers={data.partners} categoryName={data.name} />;
}
