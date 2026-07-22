import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import { api } from '@public/services/api';
import { categoryPath } from '@shared/utils/categoryPath';
import type { PartDetail, PartListing } from '@public/types/part';
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

// Price at a given quantity tier. Qty 1 is the listing's base unit_price;
// higher tiers come from the matching price break, falling back to base.
function priceAtQty(listing: PartListing, qty: number): number {
  if (qty === 1) return listing.unit_price;
  const pb = listing.price_breaks?.find((b) => b.min_quantity === qty);
  return pb ? pb.unit_price : listing.unit_price;
}

// Each distributor's search endpoint. Searching the exact manufacturer part
// number (globally unique) reliably lands the user on that specific part —
// the deep-link a sponsoring distributor is paying for. The trailing token is
// the query param; the MPN is appended url-encoded.
const DISTRIBUTOR_SEARCH: Record<string, string> = {
  'digikey.com': 'https://www.digikey.com/en/products/result?keywords=',
  'mouser.com': 'https://www.mouser.com/c/?q=',
  'arrow.com': 'https://www.arrow.com/en/products/search?q=',
  'avnet.com': 'https://www.avnet.com/shop/us/search/?term=',
  'newark.com': 'https://www.newark.com/search?st=',
  'farnell.com': 'https://www.farnell.com/search?st=',
  'element14.com': 'https://www.element14.com/search?st=',
  'rs-online.com': 'https://www.rs-online.com/web/c/?searchTerm=',
  'distrelec.com': 'https://www.distrelec.com/en/search?q=',
  'conrad.com': 'https://www.conrad.com/en/search.html?search=',
  'futureelectronics.com': 'https://www.futureelectronics.com/en/search?q=',
  'verical.com': 'https://www.verical.com/search/',
  'microchipdirect.com': 'https://www.microchipdirect.com/product/search/all/',
  'analog.com': 'https://www.analog.com/en/search.html?q=',
};

// Build a part-specific distributor URL from the supplier's domain + the MPN.
// Known distributors use their real search endpoint (subdomains like
// us.rs-online.com match the registrable domain); unknown ones get a generic
// /search?q= path. Returns null when there's no website.
function distributorUrl(website: string | null, mpn: string): string | null {
  if (!website || !mpn) return null;
  const domain = website.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const q = encodeURIComponent(mpn);
  for (const [key, base] of Object.entries(DISTRIBUTOR_SEARCH)) {
    if (domain === key || domain.endsWith('.' + key)) return base + q;
  }
  return `https://${domain.replace(/^www\./, '')}/search?q=${q}`;
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
  const navigate = useNavigate();
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
      {part && (
        <Helmet>
          <title>{part.sku} by {part.manufacturer_name} — Buy from Distributors | CircuitCenter</title>
          <meta
            name="description"
            content={`${part.description || part.sku}. Compare prices from distributors.${part.best_price != null ? ` Best price: $${part.best_price.toFixed(2)}` : ''}`}
          />
          <link rel="canonical" href={`https://circuitcenter.ai/part/${part.slug ?? id}`} />
          <script type="application/ld+json">{JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            "name": part.sku,
            "description": part.description,
            "brand": { "@type": "Brand", "name": part.manufacturer_name },
          })}</script>
        </Helmet>
      )}

      <div className={styles.partHeader}>
        <div className={styles.headerInner}>
          <button type="button" className={styles.backBtn} onClick={() => navigate(-1)}>
            ← Back
          </button>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            <Link to="/" className={styles.breadcrumbLink}>Home</Link>
            {loading ? (
              <>
                <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                <SkeletonLoader width="100px" height="16px" borderRadius="4px" />
              </>
            ) : part ? (
              <>
                {part.parent_category_name && part.parent_category_slug && (
                  <>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                    <Link
                      to={`/category/${part.parent_category_slug}`}
                      className={styles.breadcrumbLink}
                    >
                      {part.parent_category_name}
                    </Link>
                  </>
                )}
                {part.category_name && part.category_slug && (
                  <>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                    <Link
                      to={categoryPath(part.category_slug, part.parent_category_slug)}
                      className={styles.breadcrumbLink}
                    >
                      {part.category_name}
                    </Link>
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
                        <th className={styles.th}>Qty 1</th>
                        <th className={styles.th}>Qty 10</th>
                        <th className={styles.th}>Qty 100</th>
                        <th className={styles.th}>Qty 1k</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedListings.map((listing, i) => {
                        const isBest = listing.unit_price === bestPrice;
                        const url = distributorUrl(listing.supplier_website, part.sku);
                        return (
                          <motion.tr
                            key={listing.id}
                            className={`${styles.row} ${isBest ? styles.bestRow : ''} ${url ? styles.clickableRow : ''}`}
                            custom={i}
                            variants={rowVariants}
                            initial="hidden"
                            animate="visible"
                            whileHover={{ y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                            onClick={url ? (e) => {
                              if ((e.target as HTMLElement).closest('a')) return;
                              window.open(url, '_blank', 'noopener,noreferrer');
                            } : undefined}
                            title={url ? `Buy from ${listing.supplier_name}` : undefined}
                          >
                            <td className={styles.td}>
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={styles.supplierLink}
                                >
                                  {listing.supplier_name}
                                  <span className={styles.externalIcon} aria-hidden="true">&#8599;</span>
                                </a>
                              ) : (
                                <span className={styles.supplierName}>{listing.supplier_name}</span>
                              )}
                              {isBest && <span className={styles.bestBadge}>Best Price</span>}
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
                              <span className={styles.price}>{formatPrice(priceAtQty(listing, 1))}</span>
                            </td>
                            <td className={styles.td}>
                              <span className={styles.price}>{formatPrice(priceAtQty(listing, 10))}</span>
                            </td>
                            <td className={styles.td}>
                              <span className={styles.price}>{formatPrice(priceAtQty(listing, 100))}</span>
                            </td>
                            <td className={styles.td}>
                              <span className={styles.price}>{formatPrice(priceAtQty(listing, 1000))}</span>
                            </td>
                          </motion.tr>
                        );
                      })}
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
                  {part.best_price != null && (
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
    </motion.div>
  );
}
