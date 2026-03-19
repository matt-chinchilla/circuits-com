import { motion } from 'framer-motion';
import type { Supplier } from '../../types/supplier';
import styles from './TopPartners.module.scss';

interface TopPartnersProps {
  suppliers: Supplier[];
}

export default function TopPartners({ suppliers }: TopPartnersProps) {
  const featured = suppliers
    .filter((s) => s.is_featured)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 7);

  if (featured.length === 0) return null;

  return (
    <motion.div
      className={styles.topPartners}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <h3 className={styles.heading}>Top Partners</h3>
      <ul className={styles.list}>
        {featured.map((supplier, i) => (
          <li key={supplier.id} className={styles.item}>
            <span className={styles.rank}>#{i + 1}</span>
            <div className={styles.info}>
              <span className={styles.name}>{supplier.name}</span>
              <span className={styles.badge}>Preferred Partner</span>
            </div>
            {supplier.website && (
              <a
                href={supplier.website}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.link}
                aria-label={`Visit ${supplier.name}`}
              >
                →
              </a>
            )}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
