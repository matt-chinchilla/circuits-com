import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { motion } from 'framer-motion';
import SubcategoryChips from './components/SubcategoryChips';
import SupplierTable from './components/SupplierTable';
import PartsTable from './components/PartsTable';
import SponsorBlock from './components/SponsorBlock';
import CategorySponsorBanner from './components/CategorySponsorBanner';
import TopPartners from './components/TopPartners';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import Pagination from '@public/components/widgets/Pagination';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
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
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Math.max(1, parseInt(searchParams.get('p') || '1', 10) || 1);

  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<SortState>({ col: 'sku', dir: 'asc' });
  const [skuSearch, setSkuSearch] = useState('');
  const [mfgFilter, setMfgFilter] = useState<Set<string> | null>(null);
  const [subFilter, setSubFilter] = useState<Set<string> | null>(null);
  const [activeSub, setActiveSub] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    setSkuSearch('');
    setMfgFilter(null);
    setSubFilter(null);
    setActiveSub(null);
    setSort({ col: 'sku', dir: 'asc' });

    api.getCategory(slug, 1, 500, 1, 500)
      .then((data) => setCategory(data))
      .catch(() => setError('Failed to load category. Please try again later.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const isParent = category != null && category.children.length > 0;

  const activeSubInfo = useMemo(() => {
    if (!activeSub || !category || !isParent) return null;
    const child = category.children.find(c => c.slug === activeSub);
    return child ?? null;
  }, [activeSub, category, isParent]);

  const displayName = activeSubInfo?.name ?? category?.name ?? '';
  const displayIcon = activeSubInfo?.icon ?? category?.icon ?? '';

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

    if (activeSub) {
      rows = rows.filter(p => p.sub_slug === activeSub);
    }

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
  }, [allParts, activeSub, skuSearch, mfgFilter, subFilter, sort, allMfgs.length, allSubNames.length, subSlugToName, isParent]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(pageParam, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      params.delete('p');
      return params;
    });
  }, [activeSub, skuSearch, mfgFilter, subFilter, sort]);

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

  const collectionPageJsonLd = category ? {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: categoryName,
    description: category.description ?? metaDescription,
    url: `https://circuits.com/category/${category.slug}`,
  } : null;

  const breadcrumbJsonLd = category?.parent ? {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://circuits.com/' },
      { '@type': 'ListItem', position: 2, name: category.parent.name, item: `https://circuits.com/category/${category.parent.slug}` },
      { '@type': 'ListItem', position: 3, name: categoryName },
    ],
  } : null;

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      {category && (
        <Helmet>
          <title>{categoryName} — Prices &amp; Distributors | Circuits.com</title>
          <meta name="description" content={metaDescription} />
          <link rel="canonical" href={`https://circuits.com/category/${category.slug}`} />
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
            {loading ? (
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
                {isParent && activeSubInfo ? (
                  <>
                    <Link
                      to={`/category/${category.slug}`}
                      className={styles.breadcrumbLink}
                      onClick={(e) => { e.preventDefault(); setActiveSub(null); }}
                    >
                      {category.name}
                    </Link>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                    <span className={styles.breadcrumbCurrent}>{activeSubInfo.name}</span>
                  </>
                ) : (
                  <span className={styles.breadcrumbCurrent}>{category.name}</span>
                )}
              </>
            ) : null}
          </nav>

          {loading ? (
            <>
              <SkeletonLoader width="250px" height="32px" borderRadius="4px" />
              <div className={styles.skeletonChips}>
                <SkeletonLoader width="80px" height="32px" borderRadius="20px" />
                <SkeletonLoader width="100px" height="32px" borderRadius="20px" />
                <SkeletonLoader width="90px" height="32px" borderRadius="20px" />
              </div>
            </>
          ) : category ? (
            <>
              <div className={styles.titleRow}>
                <motion.h1
                  className={styles.title}
                  key={displayName}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: 'easeOut' as const }}
                >
                  {displayIcon && <span className={styles.titleIcon}><Icon name={displayIcon} /></span>}
                  {displayName}
                </motion.h1>
              </div>
              <p className={styles.headerMeta}>
                <span className={styles.headerMetaMono}>{filtered.length.toLocaleString()}</span> parts
                {isParent && !activeSubInfo && (
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

      {/* Sticky subcategory pill-bar */}
      {!loading && category && (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            <div className={styles.chipBar}>
              {isParent ? (
                <>
                  <button
                    className={`${styles.chip} ${activeSub === null ? styles.chipActive : ''}`}
                    onClick={() => setActiveSub(null)}
                  >
                    <span>All</span>
                    <span className={styles.chipCount}>{allParts.length.toLocaleString()}</span>
                  </button>
                  {category.children.map(s => (
                    <button
                      key={s.slug}
                      className={`${styles.chip} ${activeSub === s.slug ? styles.chipActive : ''}`}
                      onClick={() => setActiveSub(s.slug)}
                    >
                      <Icon name={s.icon} />
                      <span>{s.name}</span>
                      {(subCounts.get(s.slug) ?? 0) > 0 && (
                        <span className={styles.chipCount}>{subCounts.get(s.slug)}</span>
                      )}
                    </button>
                  ))}
                </>
              ) : category.parent && category.parent.children.length > 0 ? (
                <SubcategoryChips
                  subcategories={category.parent.children}
                  activeSlug={category.slug}
                />
              ) : null}
            </div>
          </div>
        </nav>
      )}

      <div className={styles.contentWide}>
        {error && <p className={styles.error}>{error}</p>}

        {/* Category Sponsor banner — parent-category pages only. Always
            rendered (empty-state when no sponsor) so the "your brand here"
            slot is discoverable. Subcategory pages get the sidebar
            SponsorBlock instead. */}
        {!loading && category && isParent && !activeSubInfo && (
          <CategorySponsorBanner sponsor={category.sponsor} categoryName={category.name} />
        )}

        {loading ? (
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
              {!isParent && <SupplierTable suppliers={category.suppliers} />}

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
              <div className={styles.sidebarGap} />
              <TopPartners suppliers={category.suppliers} />
            </div>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
