import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import type { Subcategory } from '../../types/category';
import styles from './SubcategoryChips.module.scss';

interface SubcategoryChipsProps {
  subcategories: Subcategory[];
  parentSlug: string;
}

export default function SubcategoryChips({ subcategories, parentSlug }: SubcategoryChipsProps) {
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const navigate = useNavigate();

  if (subcategories.length === 0) return null;

  const handleClick = (sub: Subcategory) => {
    if (activeSlug === sub.slug) {
      setActiveSlug(null);
    } else {
      setActiveSlug(sub.slug);
      navigate(`/category/${parentSlug}#${sub.slug}`);
    }
  };

  return (
    <div className={styles.chips}>
      {subcategories.map((sub) => {
        const isActive = activeSlug === sub.slug;
        return (
          <motion.button
            key={sub.id}
            className={`${styles.chip} ${isActive ? styles.active : ''}`}
            onClick={() => handleClick(sub)}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            {isActive && (
              <motion.span
                className={styles.activeIndicator}
                layoutId="chipIndicator"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
            <span className={styles.label}>
              {sub.icon && <span className={styles.icon}>{sub.icon}</span>}
              {sub.name}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
