import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import SearchBar from '@public/components/layout/SearchBar';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import GlowButton from '@public/components/widgets/GlowButton';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import type { SearchResults } from '@public/services/api';
import styles from './SearchPage.module.scss';

function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return '\u2014';
  return `$${price.toFixed(2)}`;
}

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.155, ease: 'easeOut' as const },
  }),
};

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSearchError(null);

    api
      .search(q)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((err) => {
        if (cancelled) return;
        // Distinguish "real error" from "empty results" — collapsing them hides
        // API outages behind a misleading sponsor-CTA card.
        console.error('[SearchPage] search failed', err);
        setResults(null);
        setSearchError("We couldn't reach search. Please retry in a moment.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [q]);

  const hasCategories = (results?.categories.length ?? 0) > 0;
  const hasSuppliers = (results?.suppliers.length ?? 0) > 0;
  const hasParts = (results?.parts?.length ?? 0) > 0;
  const hasResults = hasCategories || hasSuppliers || hasParts;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
    >

      <Helmet>
        <title>{q ? `${q} — Search Results | CircuitCenter` : 'Search Electronic Components | CircuitCenter'}</title>
        <meta name="robots" content="noindex, follow" />
      </Helmet>
      <div className={styles.searchHeader}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>
            {q ? (
              <>
                Results for <span className={styles.queryHighlight}>&ldquo;{q}&rdquo;</span>
              </>
            ) : (
              'Search'
            )}
          </h1>
          <div className={styles.searchBarRow}>
            <SearchBar variant="compact" initialQuery={q} />
          </div>
        </div>
      </div>

      <div className={styles.content}>
        {loading && (
          <div className={styles.loadingSkeleton}>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonLoader key={i} width="100%" height="80px" borderRadius="8px" />
            ))}
          </div>
        )}

        {!loading && !q.trim() && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon} aria-hidden="true">
              🔍
            </span>
            <h2 className={styles.emptyTitle}>Enter a search term</h2>
            <p className={styles.emptySubtitle}>
              Search for electronic components, categories, or suppliers.
            </p>
          </div>
        )}

        {!loading && searchError && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon} aria-hidden="true">
              ⚠
            </span>
            <h2 className={styles.emptyTitle}>{searchError}</h2>
            <p className={styles.emptySubtitle}>
              If this keeps happening, our search index may be briefly offline.
            </p>
            <Link to="/" className={styles.browseLink}>
              Back to home &rarr;
            </Link>
          </div>
        )}

        {!loading && !searchError && q.trim() && !hasResults && (
          <>
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon} aria-hidden="true">
                📭
              </span>
              <h2 className={styles.emptyTitle}>No results found</h2>
              <p className={styles.emptySubtitle}>
                We couldn&rsquo;t find anything matching &ldquo;{q}&rdquo;.
              </p>
              <Link to="/" className={styles.browseLink}>
                Browse all categories &rarr;
              </Link>
            </div>

            {/* Keyword-sponsor empty-state CTA — datasheet motif, paired with
                the keyword-landing spec card (crop-marks TR + BL here vs.
                TL + BR there). Converts unmatched search intent into a
                sponsorship lead for the exact query the user just typed. */}
            <aside
              className={styles.searchSponsorCta}
              aria-labelledby="search-sponsor-cta-title"
            >
              <div className={styles.searchSponsorCtaFrame}>
                <span className={styles.searchSponsorCtaDes} aria-hidden="true">
                  S1
                </span>
                <div className={styles.searchSponsorCtaBody}>
                  <span className={styles.searchSponsorCtaTag}>
                    SPONSOR &middot; KW-EMPTY-STATE
                  </span>
                  <h3 id="search-sponsor-cta-title">
                    Are you a vendor of{' '}
                    <code className={styles.searchSponsorCtaQ}>{q}</code>?
                  </h3>
                  <p>
                    Own this keyword. When the next buyer searches it, your
                    sponsor card answers &mdash; logo, paragraph, buy-link, and
                    a way to reach you.
                  </p>
                  <ul className={styles.searchSponsorCtaSpec}>
                    <li>
                      <span>KEYWORD</span>
                      <span>
                        <code>{q}</code>
                      </span>
                    </li>
                    <li>
                      <span>STATUS</span>
                      <span className={styles.ok}>AVAILABLE</span>
                    </li>
                    <li>
                      <span>SLA</span>
                      <span>48h to live</span>
                    </li>
                  </ul>
                </div>
                <div className={styles.searchSponsorCtaActions}>
                  <Link to={`/keyword/${encodeURIComponent(q.trim())}`}>
                    <GlowButton variant="primary">
                      Sponsor this keyword &rarr;
                    </GlowButton>
                  </Link>
                  <Link to="/keyword" className={styles.howLink}>
                    How keyword sponsorship works
                  </Link>
                </div>
              </div>
            </aside>
          </>
        )}

        {!loading && hasCategories && results && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Categories
              <span className={styles.sectionCount}>({results.categories.length})</span>
            </h2>
            <div className={styles.resultsGrid}>
              {results.categories.map((cat, i) => (
                <motion.div
                  key={cat.id}
                  custom={i}
                  initial="hidden"
                  animate="visible"
                  variants={cardVariants}
                >
                  <Link to={`/category/${cat.slug}`} className={styles.resultCard}>
                    <span className={styles.cardIcon} aria-hidden="true">
                      <Icon name={cat.icon} />
                    </span>
                    <div className={styles.cardBody}>
                      <p className={styles.cardName}>{cat.name}</p>
                      {cat.children.length > 0 && (
                        <p className={styles.cardMeta}>
                          {cat.children.length} subcategor{cat.children.length === 1 ? 'y' : 'ies'}
                        </p>
                      )}
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {!loading && hasParts && results && results.parts && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Parts
              <span className={styles.sectionCount}>({results.parts.length})</span>
            </h2>
            <div className={styles.resultsGrid}>
              {results.parts.map((part, i) => (
                <motion.div
                  key={part.id}
                  custom={i + (results.categories?.length ?? 0)}
                  initial="hidden"
                  animate="visible"
                  variants={cardVariants}
                >
                  <Link to={`/part/${part.id}`} className={styles.resultCard}>
                    <span className={styles.cardIcon} aria-hidden="true">
                      <Icon name={part.category_icon ?? 'lightning'} />
                    </span>
                    <div className={styles.cardBody}>
                      <p className={styles.cardName}>{part.sku}</p>
                      <p className={styles.cardMeta}>{part.manufacturer_name}</p>
                      {part.description && (
                        <p className={styles.cardDescription}>{part.description}</p>
                      )}
                      <div className={styles.cardFooter}>
                        <span className={styles.cardPrice}>{formatPrice(part.best_price)}</span>
                        <span className={styles.cardDistributors}>
                          {part.listings_count} distributor{part.listings_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {!loading && hasSuppliers && results && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>
              Suppliers
              <span className={styles.sectionCount}>({results.suppliers.length})</span>
            </h2>
            <div className={styles.resultsGrid}>
              {results.suppliers.map((sup, i) => (
                <motion.div
                  key={sup.id}
                  custom={i + (results.categories?.length ?? 0)}
                  initial="hidden"
                  animate="visible"
                  variants={cardVariants}
                >
                  <div className={styles.resultCard}>
                    <span className={styles.cardIcon} aria-hidden="true">
                      🏭
                    </span>
                    <div className={styles.cardBody}>
                      <p className={styles.cardName}>{sup.name}</p>
                      {sup.is_featured && (
                        <span className={styles.featuredBadge}>Featured</span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </section>
        )}
      </div>
    </motion.div>
  );
}
