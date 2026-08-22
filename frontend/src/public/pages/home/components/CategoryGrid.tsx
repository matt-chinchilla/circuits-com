import CategoryCard from '@public/components/widgets/CategoryCard';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import { categoryPartsRollup } from '@public/components/layout/BrowseDrawer/drawerCounts';
import { categoryPath } from '@shared/utils/categoryPath';
import type { Category } from '@public/types/category';
import styles from './CategoryGrid.module.scss';

interface CategoryGridProps {
  categories: Category[];
  loading: boolean;
  error: string | null;
}

export default function CategoryGrid({ categories, loading, error }: CategoryGridProps) {
  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <h2 className={styles.heading}>Browse Categories</h2>

        {error && (
          <p className={styles.error}>Failed to load categories. Please try again later.</p>
        )}

        {loading ? (
          <div className={styles.grid}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={styles.skeletonCard}>
                <SkeletonLoader width="100%" height="24px" borderRadius="4px" />
                <SkeletonLoader width="60%" height="16px" borderRadius="4px" />
                <div className={styles.skeletonPills}>
                  <SkeletonLoader width="80px" height="28px" borderRadius="20px" />
                  <SkeletonLoader width="100px" height="28px" borderRadius="20px" />
                  <SkeletonLoader width="70px" height="28px" borderRadius="20px" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.grid}>
            {categories.map((cat, index) => (
              <CategoryCard
                key={cat.id}
                to={categoryPath(cat.slug)}
                icon={cat.icon}
                name={cat.name}
                count={categoryPartsRollup(cat)}
                subs={cat.children.map((sub) => ({
                  key: sub.id,
                  name: sub.name,
                  to: categoryPath(sub.slug, cat.slug),
                }))}
                index={index}
                prefetchSlug={cat.slug}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
