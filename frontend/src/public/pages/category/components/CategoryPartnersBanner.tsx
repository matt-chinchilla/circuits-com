import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '@public/services/api';
import PreferredPartnersBanner from './PreferredPartnersBanner';
import type { CategoryPartners } from '@public/types/category';

/**
 * Preferred Partners banner — a TOP-LEVEL-category artifact (identical on the
 * parent page and every subpage). Mounted inside CategoryPage's content area
 * (below the breadcrumb + sticky sub-nav, so the page nav stays on top), which
 * means it remounts on each subcategory nav; the data is cached (SW / HTTP), so
 * the repeat fetch is cheap and there's no full reload.
 *
 * The first path segment after /category/ is the top-level slug in canonical
 * URLs; the endpoint resolves a child slug to its parent anyway, so a brief
 * pre-redirect flat-child URL still yields the correct banner. On a top-level
 * switch the stale data is cleared (setData(null)) before the new fetch resolves.
 */
function topLevelSlug(pathname: string): string | null {
  const m = pathname.match(/^\/category\/([^/]+)/);
  return m ? m[1] : null;
}

export default function CategoryPartnersBanner() {
  const { pathname } = useLocation();
  const slug = topLevelSlug(pathname);
  const [data, setData] = useState<CategoryPartners | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    // Clear stale data on a top-level switch so the previous category's partners
    // never flash on the new one. Intra-subtree nav doesn't run this — `slug`
    // is unchanged, so the banner (and its fetched data) persists untouched.
    setData(null);
    api
      .getCategoryPartners(slug)
      .then((d) => {
        if (!cancelled) setData(d);
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
