import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { motion } from 'framer-motion';
import SubcategoryChips from './components/SubcategoryChips';
import PartsTable from './components/PartsTable';
import SponsorBlock from './components/SponsorBlock';
import SilverPartners from './components/SilverPartners';
import CategoryPartnersBanner from './components/CategoryPartnersBanner';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import Pagination from '@public/components/widgets/Pagination';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import { getCategoryShell, setCategoryShell, type CategoryShell } from '@public/services/categoryShellMemo';
import { getCategoryDetailMemo, setCategoryDetailMemo } from '@shared/services/categoryDetailMemo';
import { categoryPath } from '@shared/utils/categoryPath';
import type { CategoryDetail } from '@public/types/category';
import type { PublicPart } from '@public/types/part';
import type { SortState } from './components/ColumnHeader';
import styles from './CategoryPage.module.scss';

const PAGE_SIZE = 25;

function sortParts(rows: PublicPart[], sort: SortState): PublicPart[] {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    switch (sort.col) {
      case 'sku': return dir * a.sku.localeCompare(b.sku);
      case 'desc': return dir * (a.description ?? '').localeCompare(b.description ?? '');
      case 'mfg': return dir * a.manufacturer_name.localeCompare(b.manufacturer_name);
      case 'sub': return dir * (a.sub_slug ?? '').localeCompare(b.sub_slug ?? '');
      case 'qty1': return dir * ((a.best_price ?? 0) - (b.best_price ?? 0));
      case 'qty10': return dir * ((a.best_price_10 ?? 0) - (b.best_price_10 ?? 0));
      case 'qty100': return dir * ((a.best_price_100 ?? 0) - (b.best_price_100 ?? 0));
      case 'qty1k': return dir * ((a.best_price_1000 ?? 0) - (b.best_price_1000 ?? 0));
      default: return 0;
    }
  });
}

export default function CategoryPage() {
  // Two route shapes feed this page: flat `/category/:slug` (top-level
  // categories + legacy/bookmarked child URLs) and nested
  // `/category/:parentSlug/:childSlug` (the canonical subcategory URL). The
  // child slug is globally unique, so it alone drives the API fetch; parentSlug
  // is only used to validate/canonicalize the URL (see redirect below).
  const { slug: flatSlug, childSlug } = useParams<{
    slug?: string;
    parentSlug?: string;
    childSlug?: string;
  }>();
  const slug = childSlug ?? flatSlug;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Math.max(1, parseInt(searchParams.get('p') || '1', 10) || 1);

  // Warm navigations paint parts + counts synchronously from the session memo
  // (no loading flash); cold ones fall back to null + the skeleton.
  const [category, setCategory] = useState<CategoryDetail | null>(
    () => (slug ? getCategoryDetailMemo<CategoryDetail>(slug) ?? null : null),
  );
  const [loading, setLoading] = useState(
    () => (slug ? getCategoryDetailMemo<CategoryDetail>(slug) === undefined : true),
  );
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<SortState>({ col: 'sku', dir: 'asc' });
  const [skuSearch, setSkuSearch] = useState('');
  const [mfgFilter, setMfgFilter] = useState<Set<string> | null>(null);
  const [subFilter, setSubFilter] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!slug) return;
    // Warm (memo hit): the useState initializers already painted parts + counts
    // from the memo on the first frame — revalidate silently, no skeleton. Cold
    // (miss): show the skeleton until the first fetch resolves.
    const warm = getCategoryDetailMemo<CategoryDetail>(slug) !== undefined;
    if (!warm) setLoading(true);
    setError(null);
    setSkuSearch('');
    setMfgFilter(null);
    setSubFilter(null);
    setSort({ col: 'sku', dir: 'asc' });

    let cancelled = false;
    api
      .getCategory(slug, 1, 500, 1, 500)
      .then((data) => {
        if (cancelled) return;
        setCategoryDetailMemo(slug, data);
        setCategory(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load category. Please try again later.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const isParent = category != null && category.children.length > 0;

  // Canonical URL: subcategories live nested under their parent; top-level
  // categories stay flat. Drives the redirect effect, <link rel="canonical">,
  // JSON-LD, and the `busy` guard. Computed early so the pagination-reset
  // effect below can skip itself while a redirect is pending.
  const canonicalPath = category ? categoryPath(category.slug, category.parent?.slug) : null;
  const needsCanonicalRedirect =
    !!category && !!canonicalPath && location.pathname !== canonicalPath;

  // Top-level slug from the URL (first path segment) + whether this is a nested
  // subcategory page. Drive the session "shell" memo so the breadcrumb, title,
  // and chips render synchronously on a sibling nav instead of disappearing into
  // a skeleton + re-animating on every remount (the page is pathname-keyed).
  // NOTE: on the transient flat `/category/:childSlug` URL (pre-canonical-
  // redirect) this is the CHILD slug; the `shell` memo below is category-data-
  // primary in that state, so it doesn't rely on topSlug being the parent.
  const topSlug = useMemo(() => {
    const m = location.pathname.match(/^\/category\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);
  const onChild = !!childSlug;

  // Stable top-level identity + sibling list. Prefer freshly-loaded data; fall
  // back to the session memo while a sibling-nav remount's own fetch is pending.
  const shell: CategoryShell | null = useMemo(() => {
    if (category) {
      if (isParent) {
        return { name: category.name, slug: category.slug, icon: category.icon, children: category.children };
      }
      if (category.parent) {
        const p = category.parent;
        return { name: p.name, slug: p.slug, icon: p.icon, children: p.children };
      }
    }
    return (topSlug ? getCategoryShell(topSlug) : undefined) ?? null;
  }, [category, isParent, topSlug]);

  // The current page's label + icon (breadcrumb current crumb + page title): the
  // matching sibling on a child page, the top-level itself on a parent page.
  const currentSub = useMemo(() => {
    if (!shell) return null;
    if (onChild) return shell.children.find((c) => c.slug === childSlug) ?? null;
    return { id: shell.slug, name: shell.name, slug: shell.slug, icon: shell.icon };
  }, [shell, onChild, childSlug]);

  // Display name/icon for the current crumb + the H1. Falls back to the loaded
  // category if a deep-linked child slug isn't in the cached sibling list, so the
  // title never silently blanks (currentSub null while shell is non-null).
  const titleName = currentSub?.name ?? category?.name ?? '';
  const titleIcon = currentSub?.icon ?? category?.icon ?? null;

  // Persist the shell once real data lands, so the next sibling nav has it sync.
  useEffect(() => {
    if (shell && category) setCategoryShell(shell);
  }, [shell, category]);

  const allParts = useMemo(() => {
    if (!category) return [];
    if (isParent) return category.popular_parts?.items ?? [];
    return category.parts?.items ?? [];
  }, [category, isParent]);

  const allMfgs = useMemo(() => {
    const set = new Set<string>();
    for (const p of allParts) if (p.manufacturer_name) set.add(p.manufacturer_name);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allParts]);

  const allSubNames = useMemo(() => {
    if (!category || !isParent) return [];
    return category.children.map(s => s.name);
  }, [category, isParent]);

  const subSlugToName = useMemo(() => {
    if (!category) return {};
    const children = isParent ? category.children : (category.parent?.children ?? []);
    return Object.fromEntries(children.map(s => [s.slug, s.name]));
  }, [category, isParent]);

  const subSlugToIcon = useMemo(() => {
    if (!category) return {};
    const children = isParent ? category.children : (category.parent?.children ?? []);
    return Object.fromEntries(children.map(s => [s.slug, s.icon]));
  }, [category, isParent]);

  const subCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of allParts) {
      if (p.sub_slug) map.set(p.sub_slug, (map.get(p.sub_slug) ?? 0) + 1);
    }
    return map;
  }, [allParts]);

  useEffect(() => {
    if (allMfgs.length > 0) setMfgFilter(new Set(allMfgs));
  }, [allMfgs]);

  useEffect(() => {
    if (allSubNames.length > 0) setSubFilter(new Set(allSubNames));
  }, [allSubNames]);

  const filtered = useMemo(() => {
    let rows = allParts;

    const q = skuSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter(p =>
        p.sku.toLowerCase().includes(q)
        || (p.description ?? '').toLowerCase().includes(q)
      );
    }

    if (mfgFilter && mfgFilter.size < allMfgs.length) {
      rows = rows.filter(p => mfgFilter.has(p.manufacturer_name));
    }

    if (isParent && subFilter && subFilter.size < allSubNames.length) {
      rows = rows.filter(p => subFilter.has(subSlugToName[p.sub_slug ?? ''] ?? ''));
    }

    return sortParts(rows, sort);
  }, [allParts, skuSearch, mfgFilter, subFilter, sort, allMfgs.length, allSubNames.length, subSlugToName, isParent]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(pageParam, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    // Don't touch the URL while a canonical redirect is pending: setSearchParams
    // pushes to the CURRENT (pre-redirect, flat) path and would clobber the
    // flat→nested redirect (2026-06-03 — filter-population on load fires this
    // effect and raced/reverted the redirect's replace).
    if (needsCanonicalRedirect) return;
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      params.delete('p');
      return params;
    });
  }, [skuSearch, mfgFilter, subFilter, sort, needsCanonicalRedirect]);

  const handlePageChange = (next: number) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      if (next <= 1) params.delete('p');
      else params.set('p', String(next));
      return params;
    });
    setTimeout(() => {
      document.getElementById('category-parts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const categoryName = category?.name ?? '';
  const metaDescription = category?.description
    ?? `Compare prices for ${categoryName} components from top distributors on Circuits.com.`;

  const collectionPageJsonLd = category && canonicalPath ? {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: categoryName,
    description: category.description ?? metaDescription,
    url: `https://circuits.com${canonicalPath}`,
  } : null;

  const breadcrumbJsonLd = category?.parent ? {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://circuits.com/' },
      { '@type': 'ListItem', position: 2, name: category.parent.name, item: `https://circuits.com/category/${category.parent.slug}` },
      { '@type': 'ListItem', position: 3, name: categoryName, item: `https://circuits.com${canonicalPath}` },
    ],
  } : null;

  // Canonicalize the URL: a subcategory reached via the flat `/category/:slug`
  // (legacy/bookmarked/search link) or via a wrong parent slug redirects to its
  // true nested path. Top-level categories already match → no-op.
  //
  // Effect-based (NOT a render-phase `<Navigate>`): PublicLayout wraps the
  // Outlet in `<ErrorBoundary key={location.pathname}>`, and the redirect
  // changes the pathname — i.e. that key. A `<Navigate>` returned from render
  // runs its navigate() in the rendered child's mount effect, which the keyed
  // remount dropped before it fired (category loaded, page rendered empty, URL
  // never changed — 2026-06-03). navigate() from this component's own stable
  // effect commits reliably.
  useEffect(() => {
    if (needsCanonicalRedirect && canonicalPath) {
      navigate(`${canonicalPath}${location.search}`, { replace: true });
    }
  }, [needsCanonicalRedirect, canonicalPath, location.search, navigate]);

  // While a redirect is pending, show the skeleton (not the page content at the
  // soon-to-be-replaced URL) so there's no flash of the wrong canonical.
  const busy = loading || needsCanonicalRedirect;

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      {category && canonicalPath && (
        <Helmet>
          <title>{categoryName} — Prices &amp; Distributors | Circuits.com</title>
          <meta name="description" content={metaDescription} />
          <link rel="canonical" href={`https://circuits.com${canonicalPath}`} />
          {collectionPageJsonLd && (
            <script type="application/ld+json">{JSON.stringify(collectionPageJsonLd)}</script>
          )}
          {breadcrumbJsonLd && (
            <script type="application/ld+json">{JSON.stringify(breadcrumbJsonLd)}</script>
          )}
        </Helmet>
      )}
      <div className={styles.categoryHeader}>
        <div className={styles.headerInner}>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            <Link to="/" className={styles.breadcrumbLink}>Home</Link>
            <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
            {shell && !needsCanonicalRedirect ? (
              <>
                {onChild && (
                  <>
                    <Link to={`/category/${shell.slug}`} className={styles.breadcrumbLink}>
                      {shell.name}
                    </Link>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                  </>
                )}
                <span className={styles.breadcrumbCurrent}>{titleName}</span>
              </>
            ) : busy ? (
              <SkeletonLoader width="120px" height="16px" borderRadius="4px" />
            ) : null}
          </nav>

          {shell && !needsCanonicalRedirect ? (
            <>
              <div className={styles.titleRow}>
                <h1 className={styles.title}>
                  {titleIcon && <span className={styles.titleIcon}><Icon name={titleIcon} /></span>}
                  {titleName}
                </h1>
              </div>
              {category ? (
                <p className={styles.headerMeta}>
                  <span className={styles.headerMetaMono}>{filtered.length.toLocaleString()}</span> parts
                  {isParent && (
                    <>
                      <span className={styles.headerDot}>&middot;</span>
                      <span className={styles.headerMetaMono}>{category.children.length}</span> subcategories
                    </>
                  )}
                </p>
              ) : (
                // Title is instant from the shell; only the parts count waits on
                // the fetch. 24px matches the loaded meta line so nothing shifts.
                <SkeletonLoader width="140px" height="24px" borderRadius="4px" />
              )}
            </>
          ) : busy ? (
            // Cold (parent unknown): reserve the loaded title (42px) + meta (24px)
            // heights so the banner below doesn't jump when content resolves.
            <>
              <SkeletonLoader width="250px" height="42px" borderRadius="4px" />
              <SkeletonLoader width="140px" height="24px" borderRadius="4px" />
            </>
          ) : null}
        </div>
      </div>

      {/* Sticky subcategory pill-bar — renders synchronously from the session
          shell on a sibling nav (no skeleton, no re-animation). The skeleton bar
          (6 pills that wrap like the real chips) shows only on a cold first
          visit to a parent whose shell isn't cached yet. */}
      {shell && !needsCanonicalRedirect ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            <div className={styles.chipBar}>
              {onChild ? (
                <SubcategoryChips
                  subcategories={shell.children}
                  parentSlug={shell.slug}
                  activeSlug={childSlug}
                />
              ) : (
                <>
                  {/* On the parent page, "All" is the page you're on. The
                      subcategory chips are real <Link>s to each child's nested
                      page — crawlable anchors, middle-clickable, and the fix
                      for the 2026-06-03 "subcategories only filter, never
                      navigate / child pages unreachable" bug. */}
                  <Link
                    to={categoryPath(shell.slug)}
                    className={`${styles.chip} ${styles.chipActive}`}
                    aria-current="page"
                  >
                    <span>All</span>
                    {allParts.length > 0 && (
                      <span className={styles.chipCount}>{allParts.length.toLocaleString()}</span>
                    )}
                  </Link>
                  {shell.children.map((s) => (
                    <Link
                      key={s.slug}
                      to={categoryPath(s.slug, shell.slug)}
                      className={styles.chip}
                    >
                      <Icon name={s.icon} />
                      <span>{s.name}</span>
                      {(subCounts.get(s.slug) ?? 0) > 0 && (
                        <span className={styles.chipCount}>{subCounts.get(s.slug)}</span>
                      )}
                    </Link>
                  ))}
                </>
              )}
            </div>
          </div>
        </nav>
      ) : busy ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            {/* 6 pills (All + 5 siblings) at ~real chip widths so the skeleton
                wraps to the same rows as the loaded chips (no min-height — that
                stretched single-row chips on wide screens, 2026-06-08). */}
            <div className={styles.chipBar}>
              <SkeletonLoader width="56px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="240px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="250px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="240px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="230px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="140px" height="30px" borderRadius="20px" />
            </div>
          </div>
        </nav>
      ) : null}

      <div className={styles.contentWide}>
        {error && <p className={styles.error}>{error}</p>}

        {/* Platinum Category Sponsor band — below the breadcrumb + sticky sub-nav,
            in the content-area top position. Sourced from the TOP-LEVEL category's
            /partners (via CategoryPartnersBanner), so the SAME board shows on the
            parent page and every subpage. Always present (Open-Placement fallback
            when unsold). */}
        <CategoryPartnersBanner />

        {busy ? (
          <>
            {/* Tier-row skeleton reserves the real ~340px height so the always-
                present band above doesn't snap down when content resolves. We
                can't yet know parent-vs-child, so reserve the (taller) subpage
                layout; on a parent it collapses to nothing once loaded. */}
            <div className={styles.tierRowSkeleton} aria-hidden="true">
              <SkeletonLoader width="100%" height="340px" borderRadius="14px" />
              <SkeletonLoader width="100%" height="340px" borderRadius="8px" />
            </div>
            <div className={styles.tableSkeleton}>
              <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
              ))}
            </div>
          </>
        ) : category ? (
          <>
            {/* SUBPAGES ONLY: the tier row — Silver directory (main) beside the
                Gold-tier SponsorBlock (aside). Parent pages skip it (no per-
                subcategory Gold/Silver), so parts span full width directly. */}
            {category.parent != null && (
              <div className={styles.tierRow}>
                <div className={styles.tierRowMain}>
                  <SilverPartners suppliers={category.silver ?? []} categoryName={category.name} />
                </div>
                <aside className={styles.tierRowSide}>
                  <SponsorBlock sponsor={category.sponsor} />
                </aside>
              </div>
            )}

            <section id="category-parts" className={styles.partsFull}>
              <PartsTable
                parts={visible}
                sort={sort}
                setSort={setSort}
                skuSearch={skuSearch}
                setSkuSearch={setSkuSearch}
                mfgValues={allMfgs}
                mfgSelected={mfgFilter ?? new Set(allMfgs)}
                setMfgSelected={setMfgFilter}
                subValues={isParent ? allSubNames : undefined}
                subSelected={isParent ? (subFilter ?? new Set(allSubNames)) : undefined}
                setSubSelected={isParent ? setSubFilter : undefined}
                subSlugToName={subSlugToName}
                subSlugToIcon={subSlugToIcon}
              />

              {filtered.length > PAGE_SIZE && (
                <Pagination
                  page={safePage}
                  pages={totalPages}
                  onChange={handlePageChange}
                />
              )}
            </section>
          </>
        ) : null}
      </div>
    </motion.div>
  );
}
