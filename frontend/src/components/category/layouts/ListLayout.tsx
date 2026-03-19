import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Subcategory } from '../../../types/category';
import styles from './ListLayout.module.scss';

interface ListLayoutProps {
  subcategories: Subcategory[];
  parentSlug: string;
}

export default function ListLayout({ subcategories }: ListLayoutProps) {
  return (
    <div className={styles.list}>
      {subcategories.map((sub, i) => (
        <motion.div
          key={sub.id}
          initial={{ opacity: 0, x: -15 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.03, duration: 0.3, ease: 'easeOut' as const }}
        >
          <Link to={`/category/${sub.slug}`} className={`${styles.row} ${i % 2 === 1 ? styles.alt : ''}`}>
            <span className={styles.icon} aria-hidden="true">{sub.icon}</span>
            <span className={styles.name}>{sub.name}</span>
            <span className={styles.chevron} aria-hidden="true">&rsaquo;</span>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}
