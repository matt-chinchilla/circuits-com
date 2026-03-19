import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Subcategory } from '../../../types/category';
import styles from './CompactLayout.module.scss';

interface CompactLayoutProps {
  subcategories: Subcategory[];
  parentSlug: string;
}

export default function CompactLayout({ subcategories }: CompactLayoutProps) {
  const sorted = [...subcategories].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.compact}>
      {sorted.map((sub, i) => (
        <motion.div
          key={sub.id}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.02, duration: 0.25, ease: 'easeOut' as const }}
        >
          <Link to={`/category/${sub.slug}`} className={styles.chip}>
            <span className={styles.icon} aria-hidden="true">{sub.icon}</span>
            <span className={styles.label}>{sub.name}</span>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}
