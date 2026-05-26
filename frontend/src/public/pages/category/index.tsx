import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import SubcategoryChips from './components/SubcategoryChips';
import SupplierTable from './components/SupplierTable';
import PartsTable from './components/PartsTable';
import SponsorBlock from './components/SponsorBlock';
import TopPartners from './components/TopPartners';
import LayoutSwitcher from './components/LayoutSwitcher';
import GridLayout from './components/layouts/GridLayout';
import ListLayout from './components/layouts/ListLayout';
import CompactLayout from './components/layouts/CompactLayout';
import CardsLayout from './components/layouts/CardsLayout';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import Pagination from '@public/components/widgets/Pagination';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import type { CategoryDetail } from '@public/types/category';
import styles from './CategoryPage.module.scss';

// "Popular Parts" is a curated highlight strip, not a full catalog grid.
// 12 fits a screen comfortably and gives users a clear "click to see next
// batch" rhythm. Scales linearly when the catalog grows to thousands.
const POPULAR_PER_PAGE = 12;
const PARTS_PER_PAGE = 15;

type LayoutMode = 'grid' | 'list' | 'compact' | 'cards';

const LAYOUT_COMPONENTS = {
  grid: GridLayout,
  list: ListLayout,
  compact: CompactLayout,
  cards: CardsLayout,
} as const;

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>();
  // ?p=N drives Popular Parts pagination. Deep-linkable, and back/forward
  // browser nav moves through pages naturally.
  const [searchParams, setSearchParams] = useSearchParams();
  const popularPage = Math.max(1, parseInt(searchParams.get('p') || '1', 10) || 1);
  const partsPage = Math.max(1, parseInt(searchParams.get('pp') || '1', 10) || 1);

  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutMode>('grid');

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);

    api.getCategory(slug, popularPage, POPULAR_PER_PAGE, partsPage, PARTS_PER_PAGE)
      .then((data) => setCategory(data))
      .catch(() => setError('Failed to load category. Please try again later.'))
      .finally(() => setLoading(false));
  }, [slug, popularPage, partsPage]);

  const isParent = category && category.children.length > 0;
  const LayoutComponent = LAYOUT_COMPONENTS[layout];

  const handlePopularPageChange = (next: number) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next <= 1) params.delete('p');
      else params.set('p', String(next));
      return params;
    });
    setTimeout(() => {
      document.getElementById('popular-parts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const handlePartsPageChange = (next: number) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next <= 1) params.delete('pp');
      else params.set('pp', String(next));
      return params;
    });
    setTimeout(() => {
      document.getElementById('category-parts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >

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
                <span className={styles.breadcrumbCurrent}>{category.name}</span>
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
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: 'easeOut' as const }}
                >
                  {category.icon && <span className={styles.titleIcon}><Icon name={category.icon} /></span>}
                  {category.name}
                </motion.h1>
                {isParent && <LayoutSwitcher active={layout} onChange={setLayout} />}
              </div>
              {category.children.length > 0 ? (
                /* Parent page: show own subcategories, none active. */
                <SubcategoryChips subcategories={category.children} />
              ) : category.parent && category.parent.children.length > 0 ? (
                /* Leaf page: show siblings (parent's children), mark current
                   as active. Lets the user pivot to any sibling subcategory
                   without going back to the parent. */
                <SubcategoryChips
                  subcategories={category.parent.children}
                  activeSlug={category.slug}
                />
              ) : null}
              {!isParent && category.parent && (
                <div className={styles.parentNav}>
                  <Link to={`/category/${category.parent.slug}`} className={styles.parentLink}>
                    &larr; All {category.parent.name}
                  </Link>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      <div className={styles.content}>
        {error && (
          <p className={styles.error}>{error}</p>
        )}

        {loading ? (
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <div className={styles.tableSkeleton}>
                <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
                {Array.from({ length: 5 }).map((_, i) => (
                  <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
                ))}
              </div>
            </div>
            <div className={styles.right}>
              <SkeletonLoader width="100%" height="280px" borderRadius="8px" />
            </div>
          </div>
        ) : category && isParent ? (
          /* Parent view: subcategory layouts + sidebar */
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <LayoutComponent
                subcategories={category.children}
                parentSlug={category.slug}
              />
              {category.popular_parts && category.popular_parts.total > 0 && (
                <section className={styles.partsSection} id="popular-parts">
                  <h2 className={styles.partsSectionTitle}>
                    Popular Parts
                    <span className={styles.partsSectionCount}>
                      ({category.popular_parts.total} across all subcategories)
                    </span>
                  </h2>
                  {/* Scrollable wrapper so users can wheel through this page's
                      results without scrolling the whole document. Mobile gets
                      a shorter max-height to keep the section ergonomic. */}
                  <div className={styles.popularScroll}>
                    <PartsTable parts={category.popular_parts.items} />
                  </div>
                  <Pagination
                    page={category.popular_parts.page}
                    pages={category.popular_parts.pages}
                    onChange={handlePopularPageChange}
                  />
                </section>
              )}
            </div>
            <div className={styles.right}>
              <TopPartners suppliers={category.suppliers} />
              <SponsorBlock sponsor={category.sponsor} />
            </div>
          </div>
        ) : category ? (
          /* Leaf view: supplier table + sponsor */
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <SupplierTable suppliers={category.suppliers} />
              {category.parts && category.parts.total > 0 && (
                <section className={styles.partsSection} id="category-parts">
                  <h2 className={styles.partsSectionTitle}>
                    Parts in this Category
                    <span className={styles.partsSectionCount}>({category.parts.total})</span>
                  </h2>
                  <PartsTable parts={category.parts.items} />
                  <Pagination
                    page={category.parts.page}
                    pages={category.parts.pages}
                    onChange={handlePartsPageChange}
                  />
                </section>
              )}
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
