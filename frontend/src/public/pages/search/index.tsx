// Search results page — the 2026-08-21 search & browse port (spec §2, kit
// Search.jsx as pixel authority). Query state is URL-driven (?q=): the
// in-band form, suggestion chips and manufacturer cards all navigate to
// /search?q=<term>, so results are shareable and back-button-correct.
//
// Data comes from api.searchV2(q) — the page-level call omits `suggest` so
// the server default (suggest=1) computes fuzzy recovery on zero results.
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import PageHead from '@public/components/PageHead';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import GlowButton from '@public/components/widgets/GlowButton';
import AnimatedLink from '@public/components/widgets/AnimatedLink';
import Icon from '@shared/components/Icon';
import { categoryPath } from '@shared/utils/categoryPath';
import { api } from '@public/services/api';
import type { SearchCategoryHit, SearchResultsV2 } from '@public/types/search';
import type { Supplier } from '@public/types/supplier';
import SrPartsTable from './components/SrPartsTable';
import { SrSupCard, SrSupTile } from './components/SrSupCards';
import SrSuggestions from './components/SrSuggestions';
import { displayWebsite, tierRank } from './lib/srFormat';
import styles from './SearchPage.module.scss';

// The public suppliers listing gains `tier` server-side (spec §1.4a) while
// this page is built; the Supplier contract predates it. Local widening only —
// drop once types/supplier.ts carries the field.
type SupplierWithTier = Supplier & { tier?: string | null };

const EMPTY_STATE_TILE_CAP = 12;

// Magnifier mark, kit-verbatim (Search.jsx .search-empty-mark svg).
function EmptyMark() {
  return (
    <div className={styles.emptyMark} aria-hidden="true">
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle cx="28" cy="28" r="18" fill="none" stroke="currentColor" strokeWidth="3" />
        <line x1="42" y1="42" x2="56" y2="56" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <line x1="20" y1="28" x2="36" y2="28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

// Category result card — the homepage cat-card look driven by the v2
// CategoryHit (children arrive matched-first from the server). Kit caps the
// chips at 5 with a "More…" overflow chip when 7+ exist.
function SrCatCard({ hit }: { hit: SearchCategoryHit }) {
  const navigate = useNavigate();
  const to = categoryPath(hit.slug, hit.parent_slug);
  const maxSubs = 5;
  const overflow = hit.children.length > maxSubs + 1;
  const shown = overflow ? hit.children.slice(0, maxSubs) : hit.children.slice(0, maxSubs + 1);

  return (
    <div
      className={styles.catCard}
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        navigate(to);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(to);
      }}
    >
      <div className={styles.catHead}>
        <span className={styles.catIcon} aria-hidden="true">
          <Icon name={hit.icon} />
        </span>
        <h3 className={styles.catName}>{hit.name}</h3>
      </div>
      {hit.children.length > 0 && (
        <div className={styles.catSubs}>
          {shown.map((sub) => (
            <AnimatedLink
              key={sub.slug}
              to={categoryPath(sub.slug, hit.slug)}
              className={styles.catSub}
            >
              {sub.name}
            </AnimatedLink>
          ))}
          {overflow && (
            <AnimatedLink to={to} className={`${styles.catSub} ${styles.catSubMore}`}>
              More&hellip;
            </AnimatedLink>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  // In-band input mirrors the URL (back button, suggestion chips, Clear).
  const [input, setInput] = useState(q);
  useEffect(() => {
    setInput(q);
  }, [q]);

  const [results, setResults] = useState<SearchResultsV2 | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      setSearchError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSearchError(false);

    api
      .searchV2(q)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((err) => {
        if (cancelled) return;
        // A failed request must never masquerade as an empty catalog — the
        // zero-result state carries a sponsor CTA the error state must not.
        console.error('[SearchPage] search failed', err);
        setResults(null);
        setSearchError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [q, retryTick]);

  const isEmpty = results != null && results.total === 0;

  // Empty-state BROWSE DISTRIBUTORS grid — fetched only once zero results are
  // on screen. A failed fetch hides the section quietly (null stays null).
  const [browseSuppliers, setBrowseSuppliers] = useState<SupplierWithTier[] | null>(null);
  useEffect(() => {
    if (!isEmpty || browseSuppliers != null) return;

    let cancelled = false;
    api
      .getSuppliers()
      .then((data) => {
        if (!cancelled) setBrowseSuppliers(data);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isEmpty, browseSuppliers]);

  const browseTiles = useMemo(() => {
    if (browseSuppliers == null) return [];
    return [...browseSuppliers]
      .sort(
        (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name),
      )
      .slice(0, EMPTY_STATE_TILE_CAP);
  }, [browseSuppliers]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const term = input.trim();
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
  };

  const metaText = loading
    ? 'searching\u2026'
    : results != null
      ? `${results.total} result${results.total === 1 ? '' : 's'} \u00b7 ${(results.took_ms / 1000).toFixed(3)} s`
      : '\u2014';

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
    >
      <PageHead
        seo={
          q
            ? { ...STATIC_PAGE_SEO.search, title: `${q} — Search Results | Circuit Center` }
            : STATIC_PAGE_SEO.search
        }
      />

      <div className={styles.page}>
        {/* ── Header band ── */}
        <div className={styles.header}>
          <div className={styles.headerInner}>
            <span className={styles.eyebrow}>
              {`QUERY \u00b7 ${q ? q.toUpperCase() : '\u2014'}`}
            </span>
            <h1 className={styles.title}>
              <span className={styles.titlePrefix}>Results for</span>
              <code className={styles.titleQ}>{q || '\u2014'}</code>
            </h1>
            <form className={styles.form} onSubmit={onSubmit}>
              <div className={styles.formRow}>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={'Search part numbers, manufacturers, distributors, categories\u2026'}
                  className={styles.input}
                  aria-label="Search Circuit Center"
                />
                <button type="submit" className={styles.submit}>
                  Search
                </button>
              </div>
              <div className={styles.meta}>
                <span>{metaText}</span>
                <Link to="/search" className={styles.clearLink}>
                  {'Clear \u21a9'}
                </Link>
              </div>
            </form>
          </div>
        </div>

        {/* ── Body ── */}
        <div className={styles.body}>
          <div className={styles.bodyInner}>
            {loading && (
              <div className={styles.loading} aria-hidden="true">
                <SkeletonLoader width="180px" height="15px" borderRadius="4px" />
                <SkeletonLoader width="100%" height="430px" borderRadius="10px" />
                <SkeletonLoader width="220px" height="15px" borderRadius="4px" />
                <SkeletonLoader width="100%" height="96px" borderRadius="10px" />
              </div>
            )}

            {!loading && !q.trim() && (
              <div className={styles.empty}>
                <EmptyMark />
                <h2>Search Circuit Center.</h2>
                <p>
                  Part numbers, manufacturers, distributors, categories &mdash; start typing
                  above.
                </p>
              </div>
            )}

            {!loading && searchError && (
              <div className={styles.empty}>
                <EmptyMark />
                <h2>Search is unreachable right now.</h2>
                <p>
                  The request failed before anything was matched &mdash; this is not an empty
                  catalog.
                </p>
                <button
                  type="button"
                  className={styles.retryLink}
                  onClick={() => setRetryTick((t) => t + 1)}
                >
                  Retry search
                </button>
              </div>
            )}

            {/* ── Result sections ── */}
            {!loading && !searchError && results != null && !isEmpty && (
              <>
                {results.parts.length > 0 && (
                  <section className={styles.srSection} aria-label="Matching parts">
                    <div className={styles.srLabel}>
                      <span>
                        {'PARTS \u00b7 '}
                        <b className={styles.srN}>{results.parts.length}</b>
                      </span>
                    </div>
                    <SrPartsTable rows={results.parts} />
                  </section>
                )}

                {results.manufacturers.length > 0 && (
                  <section className={styles.srSection} aria-label="Matching manufacturers">
                    <div className={styles.srLabel}>
                      <span>
                        {'MANUFACTURERS \u00b7 '}
                        <b className={styles.srN}>{results.manufacturers.length}</b>
                      </span>
                    </div>
                    <div className={styles.supGrid}>
                      {results.manufacturers.map((m) => (
                        <SrSupCard
                          key={m.name}
                          name={m.name}
                          desc={`${m.parts_count} part${m.parts_count === 1 ? '' : 's'} indexed`}
                          badge="MFR"
                          to={`/search?q=${encodeURIComponent(m.name)}`}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {results.suppliers.length > 0 && (
                  <section className={styles.srSection} aria-label="Matching distributors">
                    <div className={styles.srLabel}>
                      <span>
                        {'DISTRIBUTORS \u00b7 '}
                        <b className={styles.srN}>{results.suppliers.length}</b>
                      </span>
                    </div>
                    <div className={styles.supGrid}>
                      {results.suppliers.map((s) => (
                        <SrSupCard
                          key={s.id}
                          name={s.name}
                          desc={[s.description, displayWebsite(s.website)]
                            .filter((part): part is string => part != null && part !== '')
                            .join(' \u00b7 ')}
                          tier={s.tier}
                          logoUrl={s.logo_url}
                          to="/join"
                        />
                      ))}
                    </div>
                  </section>
                )}

                {results.categories.length > 0 && (
                  <section className={styles.srSection} aria-label="Matching categories">
                    <div className={styles.srLabel}>
                      <span>
                        {'CATEGORIES \u00b7 '}
                        <b className={styles.srN}>{results.categories.length}</b>
                      </span>
                    </div>
                    <div className={styles.catGrid}>
                      {results.categories.map((c) => (
                        <SrCatCard key={c.id} hit={c} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

            {/* ── Empty state ── */}
            {!loading && !searchError && isEmpty && (
              <>
                <div className={styles.empty}>
                  <EmptyMark />
                  <h2>
                    No exact match for <code>{q}</code>.
                  </h2>
                  <p>
                    Check the spelling or try a broader term &mdash; or jump off from the
                    near-misses and starting points below.
                  </p>

                  {results.suggestions != null && results.suggestions.length > 0 && (
                    <SrSuggestions suggestions={results.suggestions} />
                  )}

                  {results.closest_parts != null && results.closest_parts.length > 0 && (
                    <div className={`${styles.srBlock} ${styles.srBlockWide}`}>
                      <div className={styles.srLabel}>
                        <span>
                          {'CLOSEST MATCHES \u0026 POPULAR PARTS \u00b7 '}
                          <b className={styles.srN}>{results.closest_parts.length}</b>
                        </span>
                      </div>
                      <SrPartsTable rows={results.closest_parts} />
                    </div>
                  )}

                  {browseTiles.length > 0 && (
                    <div className={`${styles.srBlock} ${styles.srBlockWide}`}>
                      <div className={styles.srLabel}>
                        <span>
                          {'BROWSE DISTRIBUTORS \u00b7 '}
                          <b className={styles.srN}>{browseTiles.length}</b>
                        </span>
                      </div>
                      <div className={styles.suptileGrid}>
                        {browseTiles.map((s) => (
                          <SrSupTile
                            key={s.id}
                            name={s.name}
                            description={s.description}
                            website={s.website}
                            tier={s.tier}
                            logoUrl={s.logo_url}
                            to="/join"
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Keyword-sponsor CTA — datasheet motif, paired with the
                    keyword-landing spec card (crop-marks TR + BL here vs.
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
                        Own this keyword. When the next buyer searches it, your sponsor card
                        answers &mdash; logo, paragraph, buy-link, and a way to reach you.
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
          </div>
        </div>
      </div>
    </motion.div>
  );
}
