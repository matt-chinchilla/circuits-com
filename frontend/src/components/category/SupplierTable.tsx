import { motion } from 'framer-motion';
import type { Supplier } from '../../types/supplier';
import styles from './SupplierTable.module.scss';

function displayHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface SupplierTableProps {
  suppliers: Supplier[];
}

const rowVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.03, duration: 0.35, ease: 'easeOut' as const },
  }),
};

export default function SupplierTable({ suppliers }: SupplierTableProps) {
  if (suppliers.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No suppliers listed for this category yet.</p>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr className={styles.headerRow}>
            <th className={styles.th}>Distributor Name</th>
            <th className={styles.th}>Phone</th>
            <th className={styles.th}>Website</th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((supplier, i) => (
            <motion.tr
              key={supplier.id}
              className={`${styles.row} ${supplier.is_featured ? styles.featured : ''}`}
              custom={i}
              variants={rowVariants}
              initial="hidden"
              animate="visible"
              whileHover={{ y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
            >
              <td className={styles.td}>
                <span className={styles.name}>{supplier.name}</span>
              </td>
              <td className={styles.td}>
                {supplier.phone ? (
                  <a href={`tel:${supplier.phone}`} className={styles.phone}>
                    {supplier.phone}
                  </a>
                ) : (
                  <span className={styles.na}>--</span>
                )}
              </td>
              <td className={styles.td}>
                {supplier.website ? (
                  <a
                    href={supplier.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.website}
                  >
                    {displayHostname(supplier.website)}
                  </a>
                ) : (
                  <span className={styles.na}>--</span>
                )}
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
