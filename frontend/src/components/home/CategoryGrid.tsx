import CategoryCard from './CategoryCard';
import SkeletonLoader from '../shared/SkeletonLoader';
import type { Category } from '../../types/category';
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
              <CategoryCard key={cat.id} category={cat} index={index} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
