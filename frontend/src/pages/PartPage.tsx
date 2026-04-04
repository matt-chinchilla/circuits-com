import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import Navbar from '../components/layout/Navbar';
import Footer from '../components/layout/Footer';
import SkeletonLoader from '../components/shared/SkeletonLoader';
import CircuitTraces from '../components/shared/CircuitTraces';
import { api } from '../services/api';
import type { PartDetail } from '../types/part';
import styles from './PartPage.module.scss';

const rowVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.04, duration: 0.35, ease: 'easeOut' as const },
  }),
};

function formatPrice(price: number): string {
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

export default function PartPage() {
  const { id } = useParams<{ id: string }>();
  const [part, setPart] = useState<PartDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    api.getPartDetail(id)
      .then((data) => setPart(data))
      .catch(() => setError('Failed to load part details. Please try again later.'))
      .finally(() => setLoading(false));
  }, [id]);

  const sortedListings = part
    ? [...part.listings].sort((a, b) => a.unit_price - b.unit_price)
    : [];
  const bestPrice = sortedListings.length > 0 ? sortedListings[0].unit_price : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <Navbar />

      <div className={styles.partHeader}>
        <CircuitTraces />
        <div className={styles.headerInner}>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            <Link to="/" className={styles.breadcrumbLink}>Home</Link>
            {loading ? (
              <>
                <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                <SkeletonLoader width="100px" height="16px" borderRadius="4px" />
              </>
            ) : part ? (
              <>
                {part.category_name && (
                  <>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                    <span className={styles.breadcrumbLink}>{part.category_name}</span>
                  </>
                )}
                <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                <span className={styles.breadcrumbCurrent}>{part.sku}</span>
              </>
            ) : null}
          </nav>

          {loading ? (
            <>
              <SkeletonLoader width="300px" height="36px" borderRadius="4px" />
              <SkeletonLoader width="200px" height="20px" borderRadius="4px" />
            </>
          ) : part ? (
            <>
              <motion.h1
                className={styles.title}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: 'easeOut' as const }}
              >
                {part.sku}
              </motion.h1>
              <motion.p
                className={styles.manufacturer}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.05, ease: 'easeOut' as const }}
              >
                {part.manufacturer_name}
              </motion.p>
            </>
          ) : null}
        </div>
      </div>

      <div className={styles.content}>
        {error && (
          <p className={styles.error}>{error}</p>
        )}

        {loading ? (
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <div className={styles.tableSkeleton}>
                <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
                ))}
              </div>
            </div>
            <div className={styles.right}>
              <SkeletonLoader width="100%" height="200px" borderRadius="8px" />
            </div>
          </div>
        ) : part ? (
          <div className={styles.contentInner}>
            <div className={styles.left}>
              <h2 className={styles.sectionTitle}>
                Distributor Comparison
                <span className={styles.sectionCount}>
                  ({sortedListings.length} listing{sortedListings.length !== 1 ? 's' : ''})
                </span>
              </h2>
              {sortedListings.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr className={styles.headerRow}>
                        <th className={styles.th}>Supplier</th>
                        <th className={styles.th}>Supplier SKU</th>
                        <th className={styles.th}>Stock</th>
                        <th className={styles.th}>Unit Price</th>
                        <th className={styles.th}>Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedListings.map((listing, i) => (
                        <motion.tr
                          key={listing.id}
                          className={`${styles.row} ${listing.unit_price === bestPrice ? styles.bestRow : ''}`}
                          custom={i}
                          variants={rowVariants}
                          initial="hidden"
                          animate="visible"
                          whileHover={{ y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                        >
                          <td className={styles.td}>
                            <span className={styles.supplierName}>{listing.supplier_name}</span>
                            {listing.unit_price === bestPrice && (
                              <span className={styles.bestBadge}>Best Price</span>
                            )}
                          </td>
                          <td className={styles.td}>
                            <span className={styles.listingSku}>
                              {listing.sku || '\u2014'}
                            </span>
                          </td>
                          <td className={styles.td}>
                            <span className={styles.stock}>
                              {listing.stock_quantity.toLocaleString()}
                            </span>
                          </td>
                          <td className={styles.td}>
                            <span className={styles.price}>
                              {formatPrice(listing.unit_price)}
                            </span>
                          </td>
                          <td className={styles.td}>
                            <span className={styles.currency}>{listing.currency}</span>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.emptyListings}>
                  <p>No distributor listings available for this part yet.</p>
                </div>
              )}
            </div>

            <div className={styles.right}>
              <div className={styles.infoCard}>
                <h3 className={styles.infoCardTitle}>Part Details</h3>
                <dl className={styles.detailList}>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>SKU</dt>
                    <dd className={styles.detailValue}>{part.sku}</dd>
                  </div>
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>Manufacturer</dt>
                    <dd className={styles.detailValue}>{part.manufacturer_name}</dd>
                  </div>
                  {part.description && (
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>Description</dt>
                      <dd className={styles.detailValue}>{part.description}</dd>
                    </div>
                  )}
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>Lifecycle Status</dt>
                    <dd className={styles.detailValue}>
                      <span className={`${styles.statusBadge} ${statusClass(part.lifecycle_status)}`}>
                        {part.lifecycle_status}
                      </span>
                    </dd>
                  </div>
                  {part.category_name && (
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>Category</dt>
                      <dd className={styles.detailValue}>{part.category_name}</dd>
                    </div>
                  )}
                  {part.best_price !== null && (
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>Best Price</dt>
                      <dd className={`${styles.detailValue} ${styles.detailPrice}`}>
                        {formatPrice(part.best_price)}
                      </dd>
                    </div>
                  )}
                  <div className={styles.detailItem}>
                    <dt className={styles.detailLabel}>Distributors</dt>
                    <dd className={styles.detailValue}>{part.listings_count}</dd>
                  </div>
                </dl>
                {part.datasheet_url && (
                  <a
                    href={part.datasheet_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.datasheetLink}
                  >
                    View Datasheet
                  </a>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <Footer />
    </motion.div>
  );
}
