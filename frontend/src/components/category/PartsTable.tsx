import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { PublicPart } from '../../types/part';
import styles from './PartsTable.module.scss';

interface PartsTableProps {
  parts: PublicPart[];
}

const rowVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.03, duration: 0.35, ease: 'easeOut' as const },
  }),
};

function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return '\u2014';
  return `$${price.toFixed(2)}`;
}

function statusClass(status: string): string {
  switch (status.toLowerCase()) {
    case 'active':
      return styles.statusActive;
    case 'nrnd':
      return styles.statusNrnd;
    case 'obsolete':
      return styles.statusObsolete;
    default:
      return styles.statusActive;
  }
}

export default function PartsTable({ parts }: PartsTableProps) {
  if (parts.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No parts listed for this category yet.</p>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr className={styles.headerRow}>
            <th className={styles.th}>SKU</th>
            <th className={styles.th}>Manufacturer</th>
            <th className={`${styles.th} ${styles.thDescription}`}>Description</th>
            <th className={styles.th}>Distributors</th>
            <th className={styles.th}>Best Price</th>
            <th className={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((part, i) => (
            <motion.tr
              key={part.id}
              className={styles.row}
              custom={i}
              variants={rowVariants}
              initial="hidden"
              animate="visible"
              whileHover={{ y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
            >
              <td className={styles.td}>
                <Link to={`/part/${part.id}`} className={styles.skuLink}>
                  {part.sku}
                </Link>
              </td>
              <td className={styles.td}>
                <span className={styles.manufacturer}>{part.manufacturer_name}</span>
              </td>
              <td className={`${styles.td} ${styles.tdDescription}`}>
                <span className={styles.description}>
                  {part.description || '\u2014'}
                </span>
              </td>
              <td className={styles.td}>
                <span className={styles.count}>{part.listings_count}</span>
              </td>
              <td className={styles.td}>
                <span className={styles.price}>{formatPrice(part.best_price)}</span>
              </td>
              <td className={styles.td}>
                <span className={`${styles.statusBadge} ${statusClass(part.lifecycle_status)}`}>
                  {part.lifecycle_status}
                </span>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
