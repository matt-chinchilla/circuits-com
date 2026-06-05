import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { motion } from 'framer-motion';
import SubcategoryChips from './components/SubcategoryChips';
import PartsTable from './components/PartsTable';
import SponsorBlock from './components/SponsorBlock';
import CategoryPartnersBanner from './components/CategoryPartnersBanner';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import Pagination from '@public/components/widgets/Pagination';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
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

  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<SortState>({ col: 'sku', dir: 'asc' });
  const [skuSearch, setSkuSearch] = useState('');
  const [mfgFilter, setMfgFilter] = useState<Set<string> | null>(null);
  const [subFilter, setSubFilter] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    setSkuSearch('');
    setMfgFilter(null);
    setSubFilter(null);
    setSort({ col: 'sku', dir: 'asc' });

    api.getCategory(slug, 1, 500, 1, 500)
      .then((data) => setCategory(data))
      .catch(() => setError('Failed to load category. Please try again later.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const isParent = category != null && category.children.length > 0;

  // Canonical URL: subcategories live nested under their parent; top-level
  // categories stay flat. Drives the redirect effect, <link rel="canonical">,
  // JSON-LD, and the `busy` guard. Computed early so the pagination-reset
  // effect below can skip itself while a redirect is pending.
  const canonicalPath = category ? categoryPath(category.slug, category.parent?.slug) : null;
  const needsCanonicalRedirect =
    !!category && !!canonicalPath && location.pathname !== canonicalPath;

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
            {busy ? (
              <SkeletonLoader width="120px" height="16px" borderRadius="4px" />
            ) : category ? (
              <>
                {category.parent && (
                  <>
                    <Link to={`/category/${category.parent.slug}`} className={styles.breadcrumbLink}>
                      {category.parent.name}
                    </Link>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                  </>
                )}
                <span className={styles.breadcrumbCurrent}>{category.name}</span>
              </>
            ) : null}
          </nav>

          {busy ? (
            <>
              <SkeletonLoader width="250px" height="32px" borderRadius="4px" />
              <SkeletonLoader width="140px" height="16px" borderRadius="4px" />
            </>
          ) : category ? (
            <>
              <div className={styles.titleRow}>
                <h1 className={styles.title}>
                  {category.icon && <span className={styles.titleIcon}><Icon name={category.icon} /></span>}
                  {category.name}
                </h1>
              </div>
              <p className={styles.headerMeta}>
                <span className={styles.headerMetaMono}>{filtered.length.toLocaleString()}</span> parts
                {isParent && (
                  <>
                    <span className={styles.headerDot}>&middot;</span>
                    <span className={styles.headerMetaMono}>{category.children.length}</span> subcategories
                  </>
                )}
              </p>
            </>
          ) : null}
        </div>
      </div>

      {/* Sticky subcategory pill-bar. During load a skeleton bar reserves the
          SAME height (one row of pills) so the content below — banner + parts —
          doesn't shift down when the real chips arrive (CLS fix 2026-06-04). */}
      {busy ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            <div className={styles.chipBar}>
              <SkeletonLoader width="80px" height="32px" borderRadius="20px" />
              <SkeletonLoader width="130px" height="32px" borderRadius="20px" />
              <SkeletonLoader width="110px" height="32px" borderRadius="20px" />
              <SkeletonLoader width="120px" height="32px" borderRadius="20px" />
              <SkeletonLoader width="100px" height="32px" borderRadius="20px" />
            </div>
          </div>
        </nav>
      ) : category ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            <div className={styles.chipBar}>
              {isParent ? (
                <>
                  {/* On the parent page, "All" is the page you're on. The
                      subcategory chips are real <Link>s to each child's nested
                      page — crawlable anchors, middle-clickable, and the fix
                      for the 2026-06-03 "subcategories only filter, never
                      navigate / child pages unreachable" bug. */}
                  <Link
                    to={categoryPath(category.slug)}
                    className={`${styles.chip} ${styles.chipActive}`}
                    aria-current="page"
                  >
                    <span>All</span>
                    <span className={styles.chipCount}>{allParts.length.toLocaleString()}</span>
                  </Link>
                  {category.children.map(s => (
                    <Link
                      key={s.slug}
                      to={categoryPath(s.slug, category.slug)}
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
              ) : category.parent && category.parent.children.length > 0 ? (
                <SubcategoryChips
                  subcategories={category.parent.children}
                  parentSlug={category.parent.slug}
                  activeSlug={category.slug}
                />
              ) : null}
            </div>
          </div>
        </nav>
      ) : null}

      <div className={styles.contentWide}>
        {error && <p className={styles.error}>{error}</p>}

        {/* Preferred Partners banner — below the breadcrumb + sticky sub-nav, in
            its original content-area position. Sourced from the TOP-LEVEL
            category's /partners (via CategoryPartnersBanner), so it shows the
            same partners on the parent page and every subpage. */}
        <CategoryPartnersBanner />

        {busy ? (
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <div className={styles.tableSkeleton}>
                <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
                ))}
              </div>
            </div>
            <div className={styles.right}>
              <SkeletonLoader width="100%" height="280px" borderRadius="8px" />
            </div>
          </div>
        ) : category ? (
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <section id="category-parts">
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
            </div>
            <div className={styles.right}>
              <SponsorBlock sponsor={category.sponsor} />
            </div>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
