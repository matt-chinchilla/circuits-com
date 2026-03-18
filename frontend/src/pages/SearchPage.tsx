import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import Navbar from '../components/layout/Navbar';
import Footer from '../components/layout/Footer';
import SearchBar from '../components/layout/SearchBar';
import SkeletonLoader from '../components/shared/SkeletonLoader';
import { api } from '../services/api';
import type { SearchResults } from '../services/api';
import styles from './SearchPage.module.scss';

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.35, ease: 'easeOut' as const },
  }),
};

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api
      .search(q)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch(() => {
        if (!cancelled) setResults({ categories: [], suppliers: [] });
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
  const hasResults = hasCategories || hasSuppliers;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <Navbar />

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

        {!loading && q.trim() && !hasResults && (
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
                      {cat.icon}
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

      <Footer />
    </motion.div>
  );
}
