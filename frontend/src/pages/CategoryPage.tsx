import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import Footer from '../components/layout/Footer';
import SubcategoryChips from '../components/category/SubcategoryChips';
import SupplierTable from '../components/category/SupplierTable';
import PartsTable from '../components/category/PartsTable';
import SponsorBlock from '../components/category/SponsorBlock';
import TopPartners from '../components/category/TopPartners';
import LayoutSwitcher from '../components/category/LayoutSwitcher';
import GridLayout from '../components/category/layouts/GridLayout';
import ListLayout from '../components/category/layouts/ListLayout';
import CompactLayout from '../components/category/layouts/CompactLayout';
import CardsLayout from '../components/category/layouts/CardsLayout';
import SkeletonLoader from '../components/shared/SkeletonLoader';
import { api } from '../services/api';
import type { CategoryDetail } from '../types/category';
import styles from './CategoryPage.module.scss';

type LayoutMode = 'grid' | 'list' | 'compact' | 'cards';

const LAYOUT_COMPONENTS = {
  grid: GridLayout,
  list: ListLayout,
  compact: CompactLayout,
  cards: CardsLayout,
} as const;

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutMode>('grid');

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);

    api.getCategory(slug)
      .then((data) => setCategory(data))
      .catch(() => setError('Failed to load category. Please try again later.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const isParent = category && category.children.length > 0;
  const LayoutComponent = LAYOUT_COMPONENTS[layout];

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
                  {category.icon && <span className={styles.titleIcon}>{category.icon}</span>}
                  {category.name}
                </motion.h1>
                {isParent && <LayoutSwitcher active={layout} onChange={setLayout} />}
              </div>
              {category.children.length > 0 && (
                <SubcategoryChips
                  subcategories={category.children}
                  parentSlug={category.slug}
                />
              )}
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
              {category.parts && category.parts.length > 0 && (
                <section className={styles.partsSection}>
                  <h2 className={styles.partsSectionTitle}>
                    Parts in this Category
                    <span className={styles.partsSectionCount}>({category.parts.length})</span>
                  </h2>
                  <PartsTable parts={category.parts} />
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
              {category.parts && category.parts.length > 0 && (
                <section className={styles.partsSection}>
                  <h2 className={styles.partsSectionTitle}>
                    Parts in this Category
                    <span className={styles.partsSectionCount}>({category.parts.length})</span>
                  </h2>
                  <PartsTable parts={category.parts} />
                </section>
              )}
            </div>
            <div className={styles.right}>
              <SponsorBlock sponsor={category.sponsor} />
            </div>
          </div>
        ) : null}
      </div>

      <Footer />
    </motion.div>
  );
}
