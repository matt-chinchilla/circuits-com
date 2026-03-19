import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Subcategory } from '../../../types/category';
import styles from './CardsLayout.module.scss';

interface CardsLayoutProps {
  subcategories: Subcategory[];
  parentSlug: string;
}

export default function CardsLayout({ subcategories }: CardsLayoutProps) {
  return (
    <div className={styles.cards}>
      {subcategories.map((sub, i) => (
        <motion.div
          key={sub.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05, duration: 0.35, ease: 'easeOut' as const }}
        >
          <Link to={`/category/${sub.slug}`} className={styles.card}>
            <span className={styles.icon} aria-hidden="true">{sub.icon}</span>
            <div className={styles.info}>
              <span className={styles.name}>{sub.name}</span>
            </div>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}
