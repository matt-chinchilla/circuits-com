import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import { categoryPath } from '@shared/utils/categoryPath';
import type { Subcategory } from '@public/types/category';
import styles from './SubcategoryChips.module.scss';

interface SubcategoryChipsProps {
  subcategories: Subcategory[];
  // The parent category's slug — subcategories navigate to the nested
  // `/category/{parentSlug}/{slug}` canonical URL. Required so sibling chips on
  // a subcategory page jump to the correct nested page (not a flat slug, which
  // would only redirect).
  parentSlug: string;
  // The slug of the chip that should appear active. When rendered on a
  // subcategory page, this is the current page's slug (passed from the
  // CategoryPage so the URL stays the source of truth, not local state).
  // Omit on parent pages — no chip starts active there.
  activeSlug?: string | null;
}

export default function SubcategoryChips({ subcategories, parentSlug, activeSlug = null }: SubcategoryChipsProps) {
  const navigate = useNavigate();

  if (subcategories.length === 0) return null;

  return (
    <div className={styles.chips}>
      {/* "All" returns to the parent's all-parts view — restores the parent
          page's "All" chip on subcategory pages so the sub-nav is consistent. */}
      <motion.button
        key="__all__"
        className={styles.chip}
        onClick={() => navigate(categoryPath(parentSlug))}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <span className={styles.label}>All</span>
      </motion.button>
      {subcategories.map((sub) => {
        const isActive = activeSlug === sub.slug;
        return (
          <motion.button
            key={sub.id}
            className={`${styles.chip} ${isActive ? styles.active : ''}`}
            onClick={() => navigate(categoryPath(sub.slug, parentSlug))}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            aria-current={isActive ? 'page' : undefined}
          >
            {isActive && (
              <motion.span
                className={styles.activeIndicator}
                layoutId="chipIndicator"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
            <span className={styles.label}>
              {sub.icon && <span className={styles.icon}><Icon name={sub.icon} /></span>}
              {sub.name}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
