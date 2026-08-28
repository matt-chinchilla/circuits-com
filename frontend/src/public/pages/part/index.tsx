import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import PageHead from '@public/components/PageHead';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import { partSeo } from '@public/services/seoRoutes';
import { categoryPath } from '@shared/utils/categoryPath';
import { safeHttpUrl, safeImageUrl } from '@shared/utils/url';
import type { PartDetail, PartListing, RelatedPart, RelatedParts } from '@public/types/part';
import InventoryChart from './InventoryChart';
import PackageArt, { packageFamily } from './packageArt';
import { extractSpecs } from './partSynth';
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

// A visitor leaving us for a distributor's own site — the ONE per-supplier
// demand signal this site can honestly record, since we never see what happens
// in the distributor's basket. `sendBeacon` hands the POST to the browser to
// send outside the page's lifetime, so it survives the tab navigating away and
// cannot delay the click; the endpoint answers 204 to everything, so there is
// no response to handle. Absent on older browsers — skip silently, because
// analytics is never worth breaking a click-through for.
function pingOutbound(partId: string, supplierId: string): void {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  const body = new Blob([JSON.stringify({ part_id: partId, supplier_id: supplierId })], {
    type: 'application/json',
  });
  try {
    navigator.sendBeacon('/api/outbound', body);
  } catch {
    // Queue full, or a browser that throws instead of returning false.
  }
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// The four datasheet-style crop marks framing the header sheet.
function CropMarks() {
  return (
    <>
      <i className={styles.crop} data-corner="tl" aria-hidden="true" />
      <i className={styles.crop} data-corner="tr" aria-hidden="true" />
      <i className={styles.crop} data-corner="bl" aria-hidden="true" />
      <i className={styles.crop} data-corner="br" aria-hidden="true" />
    </>
  );
}

function RelatedCard({ part }: { part: RelatedPart }) {
  return (
    <Link to={`/part/${part.slug ?? part.id}`} className={styles.relCard}>
      <span className={styles.relSku}>{part.sku}</span>
      <span className={styles.relMfr}>{part.manufacturer_name}</span>
      {part.description && <span className={styles.relDesc}>{part.description}</span>}
      <span className={styles.relMeta}>
        {part.best_price != null && (
          <span className={styles.relPrice}>{formatPrice(part.best_price)}</span>
        )}
        {part.total_stock != null && (
          <span className={styles.relStock}>{part.total_stock.toLocaleString()} in stock</span>
        )}
      </span>
    </Link>
  );
}

export default function PartPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [part, setPart] = useState<PartDetail | null>(null);
  const [related, setRelated] = useState<RelatedParts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A dead remote image must fall through to the package art / icon tiers,
  // not render a broken-image glyph.
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRelated(null);
    setImgFailed(false);

    api.getPartDetail(id)
      .then((data) => {
        if (cancelled) return;
        setPart(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load part details. Please try again later.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Related rows load after the part resolves (needs the real UUID — the
  // route param may be a slug). Best-effort: a failure just hides the rows.
  useEffect(() => {
    if (!part?.id) return;
    let cancelled = false;
    api.getRelatedParts(part.id)
      .then((data) => {
        if (!cancelled) setRelated(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [part?.id]);

  const sortedListings = part
    ? [...part.listings].sort((a, b) => a.unit_price - b.unit_price)
    : [];
  const bestPrice = sortedListings.length > 0 ? sortedListings[0].unit_price : null;
  const worstPrice = sortedListings.length > 0
    ? sortedListings[sortedListings.length - 1].unit_price
    : null;
  const totalStock = part?.total_stock
    ?? sortedListings.reduce((sum, li) => sum + (li.stock_quantity || 0), 0);
  const medianLead = median(
    sortedListings
      .map((li) => li.lead_time_days)
      .filter((d): d is number => d != null),
  );

  const specs = useMemo(() => extractSpecs(part?.description ?? null), [part?.description]);
  const partImage = safeImageUrl(part?.image_url ?? null);
  // Image tier 2: a representative package render keyed off the parsed
  // package token (the distributor "image is a representation only" pattern).
  const pkgFamily = packageFamily(specs.find((s) => s.label === 'Package')?.value);
  // Stored external href — must pass safeHttpUrl before reaching href=
  // (same stored-XSS rule as sponsor websites; null hides the link).
  const datasheetHref = safeHttpUrl(part?.datasheet_url ?? null);
  const updatedLabel = part?.updated_at
    ? new Date(part.updated_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null;

  const seo = part
    ? partSeo({
        sku: part.sku,
        manufacturerName: part.manufacturer_name,
        slug: part.slug ?? id ?? '',
        description: part.description,
        categoryName: part.category_name,
        bestPrice: part.best_price,
        categoryPath: part.category_slug
          ? categoryPath(part.category_slug, part.parent_category_slug)
          : null,
      })
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      {seo && <PageHead seo={seo} />}

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
        </div>
      </div>

      <div className={styles.content}>
        {error && <p className={styles.error}>{error}</p>}

        {loading ? (
          <div className={styles.sheet}>
            <div className={styles.sheetGrid}>
              <SkeletonLoader width="180px" height="180px" borderRadius="8px" />
              <div className={styles.sheetBody}>
                <SkeletonLoader width="300px" height="40px" borderRadius="4px" />
                <SkeletonLoader width="200px" height="20px" borderRadius="4px" />
                <SkeletonLoader width="100%" height="60px" borderRadius="4px" />
              </div>
            </div>
          </div>
        ) : part ? (
          <>
            {/* ── The "live datasheet" sheet ────────────────────────────── */}
            <motion.section
              className={styles.sheet}
              aria-label="Part summary"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' as const }}
            >
              <CropMarks />
              <span className={`${styles.stamp} ${statusClass(part.lifecycle_status)}`} aria-hidden="true">
                {part.lifecycle_status}
              </span>
              <div className={styles.sheetGrid}>
                <figure className={styles.plate}>
                  {partImage && !imgFailed ? (
                    <img
                      className={styles.plateImg}
                      src={partImage}
                      alt={`${part.sku} product photo`}
                      onError={() => setImgFailed(true)}
                    />
                  ) : pkgFamily ? (
                    <span className={`${styles.plateIcon} ${styles.plateArt}`} aria-hidden="true">
                      <PackageArt family={pkgFamily} />
                    </span>
                  ) : (
                    <span className={styles.plateIcon} aria-hidden="true">
                      <Icon name={part.category_icon ?? 'cpu'} />
                    </span>
                  )}
                  {/* figcaption must be first or last child of figure — the
                      disclaimer lives INSIDE it, not after it. */}
                  <figcaption className={styles.plateCaption}>
                    <span className={styles.plateLabel}>
                      {part.category_name ?? 'Component'}
                    </span>
                    {(!partImage || imgFailed) && pkgFamily && (
                      <span className={styles.plateDisclaimer}>
                        Representative image only &mdash; refer to the datasheet for
                        exact specifications.
                      </span>
                    )}
                  </figcaption>
                </figure>
                <div className={styles.sheetBody}>
                  <h1 className={styles.sheetSku}>{part.sku}</h1>
                  <p className={styles.sheetMfr}>{part.manufacturer_name}</p>
                  <h2 className={styles.genDescLabel}>General description</h2>
                  <p className={styles.genDesc}>
                    {part.description ??
                      `${part.category_name ?? 'Electronic component'} from ${part.manufacturer_name}.`}
                  </p>
                  <div className={styles.sheetMeta}>
                    {datasheetHref && (
                      <a
                        href={datasheetHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.datasheetLink}
                      >
                        View datasheet {'↗'}
                      </a>
                    )}
                    {part.category_name && part.category_slug && (
                      <Link
                        to={categoryPath(part.category_slug, part.parent_category_slug)}
                        className={styles.metaChip}
                      >
                        <Icon name={part.category_icon ?? ''} /> {part.category_name}
                      </Link>
                    )}
                    {updatedLabel && (
                      <span className={styles.revLine}>REV &mdash; {updatedLabel}</span>
                    )}
                  </div>
                </div>
              </div>
            </motion.section>

            {/* ── Supply-chain strip (all real listing data) ────────────── */}
            {sortedListings.length > 0 && (
              <section className={styles.stripGrid} aria-label="Supply chain summary">
                <div className={styles.stripTile}>
                  <span className={styles.stripValue}>{totalStock.toLocaleString()}</span>
                  <span className={styles.stripLabel}>Units in stock</span>
                </div>
                <div className={styles.stripTile}>
                  <span className={styles.stripValue}>{sortedListings.length}</span>
                  <span className={styles.stripLabel}>Distributors</span>
                </div>
                {bestPrice != null && (
                  <div className={styles.stripTile}>
                    <span className={styles.stripValue}>{formatPrice(bestPrice)}</span>
                    <span className={styles.stripLabel}>Best price</span>
                  </div>
                )}
                {bestPrice != null && worstPrice != null && worstPrice > bestPrice && (
                  <div className={styles.stripTile}>
                    <span className={styles.stripValue}>
                      {formatPrice(bestPrice)}&ndash;{formatPrice(worstPrice)}
                    </span>
                    <span className={styles.stripLabel}>Price spread</span>
                  </div>
                )}
                {medianLead != null && (
                  <div className={styles.stripTile}>
                    <span className={styles.stripValue}>{medianLead} days</span>
                    <span className={styles.stripLabel}>Median lead time</span>
                  </div>
                )}
              </section>
            )}

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
                          <th className={`${styles.th} ${styles.colSku}`}>Supplier SKU</th>
                          <th className={styles.th}>Stock</th>
                          <th className={styles.th}>Lead Time</th>
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
                                // The supplier link is a real <a> with its own
                                // beacon — let it fire once, not twice.
                                if ((e.target as HTMLElement).closest('a')) return;
                                pingOutbound(part.id, listing.supplier_id);
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
                                    onClick={() => pingOutbound(part.id, listing.supplier_id)}
                                  >
                                    {listing.supplier_name}
                                    <span className={styles.externalIcon} aria-hidden="true">&#8599;</span>
                                  </a>
                                ) : (
                                  <span className={styles.supplierName}>{listing.supplier_name}</span>
                                )}
                                {isBest && <span className={styles.bestBadge}>Best Price</span>}
                              </td>
                              <td className={`${styles.td} ${styles.colSku}`}>
                                <span className={styles.listingSku}>
                                  {listing.sku || '—'}
                                </span>
                              </td>
                              <td className={styles.td}>
                                <span className={styles.stock}>
                                  {listing.stock_quantity.toLocaleString()}
                                </span>
                              </td>
                              <td className={styles.td}>
                                <span className={styles.stock}>
                                  {listing.lead_time_days != null
                                    ? `${listing.lead_time_days} days`
                                    : '—'}
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

                {sortedListings.length > 0 && (
                  <>
                    <h2 className={`${styles.sectionTitle} ${styles.sectionSpaced}`}>
                      Inventory History
                    </h2>
                    <div className={styles.chartCard}>
                      <InventoryChart seedKey={part.id} currentStock={totalStock} />
                    </div>
                  </>
                )}
              </div>

              <div className={styles.right}>
                <div className={styles.infoCard}>
                  <h3 className={styles.infoCardTitle}>Technical Specifications</h3>
                  {specs.length > 0 && (
                    <dl className={styles.detailList}>
                      {specs.map((s) => (
                        <div key={s.label} className={styles.detailItem}>
                          <dt className={styles.detailLabel}>{s.label}</dt>
                          <dd className={`${styles.detailValue} ${styles.specValue}`}>{s.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <h4 className={styles.specGroupTitle}>Catalog data</h4>
                  <dl className={styles.detailList}>
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>MPN</dt>
                      <dd className={`${styles.detailValue} ${styles.specValue}`}>{part.sku}</dd>
                    </div>
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>Manufacturer</dt>
                      <dd className={styles.detailValue}>{part.manufacturer_name}</dd>
                    </div>
                    {part.category_name && (
                      <div className={styles.detailItem}>
                        <dt className={styles.detailLabel}>Category</dt>
                        <dd className={styles.detailValue}>{part.category_name}</dd>
                      </div>
                    )}
                    <div className={styles.detailItem}>
                      <dt className={styles.detailLabel}>Lifecycle</dt>
                      <dd className={styles.detailValue}>
                        <span className={`${styles.statusBadge} ${statusClass(part.lifecycle_status)}`}>
                          {part.lifecycle_status}
                        </span>
                      </dd>
                    </div>
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
                      {/* listings_count only exists on the LIST payload; the
                          detail endpoint ships the listings themselves. */}
                      <dd className={styles.detailValue}>{sortedListings.length}</dd>
                    </div>
                    {totalStock > 0 && (
                      <div className={styles.detailItem}>
                        <dt className={styles.detailLabel}>Total stock</dt>
                        <dd className={styles.detailValue}>{totalStock.toLocaleString()}</dd>
                      </div>
                    )}
                  </dl>
                  {datasheetHref && (
                    <a
                      href={datasheetHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.datasheetBtn}
                    >
                      View Datasheet
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* ── Related rows ──────────────────────────────────────────── */}
            {related && related.alternates.length > 0 && (
              <section className={styles.relatedSection} aria-label="Alternate parts">
                <h2 className={styles.sectionTitle}>Alternate Parts</h2>
                <div className={styles.relatedGrid}>
                  {related.alternates.map((p) => <RelatedCard key={p.id} part={p} />)}
                </div>
              </section>
            )}
            {related && related.companions.length > 0 && (
              <section className={styles.relatedSection} aria-label="Frequently paired parts">
                <h2 className={styles.sectionTitle}>Often Paired With</h2>
                <div className={styles.relatedGrid}>
                  {related.companions.map((p) => <RelatedCard key={p.id} part={p} />)}
                </div>
              </section>
            )}
          </>
        ) : null}
      </div>
    </motion.div>
  );
}
