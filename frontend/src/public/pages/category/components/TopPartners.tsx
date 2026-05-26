import { motion } from 'framer-motion';
import type { Supplier } from '@public/types/supplier';
import styles from './TopPartners.module.scss';

interface TopPartnersProps {
  suppliers: Supplier[];
}

export default function TopPartners({ suppliers }: TopPartnersProps) {
  const top = [...suppliers]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5);

  if (top.length === 0) return null;

  return (
    <motion.div
      className={styles.card}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <h3 className={styles.title}>Top Distributors</h3>
      {top.map((supplier) => (
        <div key={supplier.id} className={styles.row}>
          <span className={styles.label}>{supplier.name}</span>
          <span className={styles.tier}>Silver</span>
        </div>
      ))}
    </motion.div>
  );
}
