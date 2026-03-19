import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Subcategory } from '../../../types/category';
import styles from './GridLayout.module.scss';

interface GridLayoutProps {
  subcategories: Subcategory[];
  parentSlug: string;
}

export default function GridLayout({ subcategories }: GridLayoutProps) {
  return (
    <div className={styles.grid}>
      {subcategories.map((sub, i) => (
        <motion.div
          key={sub.id}
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.3, ease: 'easeOut' as const }}
        >
          <Link to={`/category/${sub.slug}`} className={styles.tile}>
            <span className={styles.iconCircle} aria-hidden="true">
              {sub.icon}
            </span>
            <span className={styles.name}>{sub.name}</span>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}
