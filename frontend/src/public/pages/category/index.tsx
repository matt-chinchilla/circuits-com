import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import SubcategoryChips from './components/SubcategoryChips';
import SubcatSheet from './components/SubcatSheet';
import PartsTable from './components/PartsTable';
import SponsorBlock from './components/SponsorBlock';
import SilverPartners from './components/SilverPartners';
import SilverCheckoutModal from './components/SilverCheckoutModal';
import CategoryPartnersBanner from './components/CategoryPartnersBanner';
import SkeletonLoader from '@public/components/widgets/SkeletonLoader';
import Pagination from '@public/components/widgets/Pagination';
import PageHead from '@public/components/PageHead';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import {
  categoryQuerySignature,
  categoryRequestQuery,
  isUnknownSortError,
  parseCategoryQuery,
  writeCategoryQuery,
  type CategoryQueryPatch,
} from '@public/services/categoryQuery';
import { categorySeo } from '@public/services/seoRoutes';
import { getCategoryShell, setCategoryShell, type CategoryShell } from '@public/services/categoryShellMemo';
import {
  categoryRowsKey,
  getCategoryChromeMemo,
  getCategoryRowsMemo,
  setCategoryChromeMemo,
  setCategoryRowsMemo,
} from '@shared/services/categoryDetailMemo';
import { categoryPath } from '@shared/utils/categoryPath';
import type { CategoryChrome, CategoryDetail, CategoryFacets, PartsPage } from '@public/types/category';
import type { FilterOption, SortState } from './components/ColumnHeader';
import styles from './CategoryPage.module.scss';

// One page of rows plus the facet counts that describe the same request.
// They travel together because they are answered together and expire together.
interface CategoryRows {
  parts: PartsPage;
  facets: CategoryFacets | null;
}

// The search box commits after the typing settles. Long enough that a normal
// burst of keystrokes is ONE request; short enough that a pause feels like a
// live search.
const SEARCH_DEBOUNCE_MS = 300;

function toChrome(data: CategoryDetail): CategoryChrome {
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    icon: data.icon,
    description: data.description ?? null,
    parts_count: data.parts_count ?? null,
    children: data.children,
    parent: data.parent,
    sponsor: data.sponsor,
    silver: data.silver,
  };
}

export default function CategoryPage() {
  // Two route shapes feed this page: flat `/category/:slug` (top-level
  // categories + legacy/bookmarked child URLs) and nested
  // `/category/:parentSlug/:childSlug` (the canonical subcategory URL). The
  // child slug is globally unique, so it alone drives the API fetch; parentSlug
  // is only used to validate/canonicalize the URL (see redirect below).
  const { slug: flatSlug, childSlug } = useParams<{
    slug?: string;
    parentSlug?: string;
    childSlug?: string;
  }>();
  const slug = childSlug ?? flatSlug;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── The URL IS the state ──────────────────────────────────────────────────
  // Sort, filters, search and page all live in the query string, so back /
  // forward and a pasted link reproduce exactly what the sender was looking at
  // — and the server, not the browser, does the sorting and filtering. (The
  // catalog passed 200k parts: 27 of 28 top-level categories overflowed the old
  // 500-row client-side fetch, so the page silently showed 500 of 39,353 and
  // the header count agreed with the truncation.)
  const paramString = searchParams.toString();
  const query = useMemo(() => parseCategoryQuery(new URLSearchParams(paramString)), [paramString]);
  const requestQuery = useMemo(() => categoryRequestQuery(query), [query]);
  const rowsKey = slug ? categoryRowsKey(slug, categoryQuerySignature(query)) : '';
  const filtersActive = query.q !== '' || query.mfg.length > 0 || query.sub.length > 0;

  // Post-checkout greeting (?welcome=silver — the Stripe success_url). Read
  // ONCE at mount, then stripped from the URL so a refresh or share doesn't
  // replay the banner. Functional setSearchParams — never in effect deps
  // (the RR v7 identity trap in CLAUDE.md).
  const [welcome, setWelcome] = useState(
    () => new URLSearchParams(window.location.search).get('welcome') === 'silver',
  );
  useEffect(() => {
    if (!welcome) return;
    setSearchParams(
      prev => {
        prev.delete('welcome');
        return prev;
      },
      { replace: true },
    );
  }, []);

  // Warm navigations paint synchronously from the session memos (no loading
  // flash): the CHROME by slug — header, chips, sponsor boards, the half that
  // never changes as you sort — and the ROWS by slug + query signature, so a
  // ?p=5&sort=qty100 URL can only ever paint its own rows.
  const [chrome, setChrome] = useState<CategoryChrome | null>(
    () => (slug ? getCategoryChromeMemo<CategoryChrome>(slug) ?? null : null),
  );
  // Rows carry the key they answer. That is what tells a silent revalidation
  // (the memo already holds THIS query's rows) apart from an interaction whose
  // rows have not arrived yet (the table is still showing the previous query) —
  // only the second one earns the "updating" dim.
  const [rowsState, setRowsState] = useState<{ key: string; data: CategoryRows } | null>(() => {
    const cached = getCategoryRowsMemo<CategoryRows>(rowsKey);
    return cached === undefined ? null : { key: rowsKey, data: cached };
  });
  const rows = rowsState?.data ?? null;
  // `loading` = a NAVIGATION with nothing cached → skeletons for the whole
  // content area, and ONLY that. `fetching` = a request is in flight for any
  // reason; it surfaces as the dim (see `updating` below) rather than as
  // skeletons, so a sort or page click never flashes the layout.
  const [loading, setLoading] = useState(
    () => (slug ? getCategoryChromeMemo(slug) === undefined : true),
  );
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This component REMOUNTS on every category navigation (PublicLayout keys its
  // ErrorBoundary on the pathname), so a re-run of the fetch effect within one
  // mount is always an interaction — a sort, a filter, a page — never a nav.
  const firstLoadRef = useRef(true);
  const sortHealedRef = useRef(false);
  const redirectPendingRef = useRef(false);

  useEffect(() => {
    if (!slug) return;
    const navigating = firstLoadRef.current;
    firstLoadRef.current = false;

    const cachedRows = getCategoryRowsMemo<CategoryRows>(rowsKey);
    if (cachedRows !== undefined) setRowsState({ key: rowsKey, data: cachedRows });
    if (navigating) setLoading(getCategoryChromeMemo(slug) === undefined);
    setFetching(true);
    setError(null);

    let cancelled = false;
    api
      .getCategory(slug, requestQuery)
      .then((data) => {
        if (cancelled) return;
        const nextChrome = toChrome(data);
        const nextRows: CategoryRows = { parts: data.parts, facets: data.facets ?? null };
        setCategoryChromeMemo(slug, nextChrome);
        setCategoryRowsMemo(rowsKey, nextRows);
        setChrome(nextChrome);
        setRowsState({ key: rowsKey, data: nextRows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A link asking a parent-only order (`popular`, `sub`) of a LEAF is a
        // 422, not a page. Heal the URL once instead of dead-ending on the
        // error card; the retry lands on the server's own default ordering.
        if (isUnknownSortError(err) && !sortHealedRef.current) {
          sortHealedRef.current = true;
          setSearchParams(prev => writeCategoryQuery(prev, { sort: null }), { replace: true });
          return;
        }
        setError('Failed to load category. Please try again later.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, rowsKey, requestQuery]);

  const isParent = chrome != null && chrome.children.length > 0;

  // Canonical URL: subcategories live nested under their parent; top-level
  // categories stay flat. Drives the redirect effect, <link rel="canonical">,
  // JSON-LD, and the `busy` guard.
  const canonicalPath = chrome ? categoryPath(chrome.slug, chrome.parent?.slug) : null;
  const needsCanonicalRedirect =
    !!chrome && !!canonicalPath && location.pathname !== canonicalPath;
  useEffect(() => {
    redirectPendingRef.current = needsCanonicalRedirect;
  }, [needsCanonicalRedirect]);

  /**
   * The single writer for this page's query params.
   *
   * `writeCategoryQuery` already resets `?p` whenever WHAT is listed changes,
   * so the old "reset page on filter change" effect — and the race where its
   * write clobbered the pending flat→nested redirect (2026-06-03) — is gone.
   * The ref guard survives for the one caller that can still fire while a
   * redirect is pending: the search debounce, which is a timer, not a click.
   */
  const patchQuery = (patch: CategoryQueryPatch, replace = false) => {
    if (redirectPendingRef.current) return;
    setSearchParams(prev => writeCategoryQuery(prev, patch), { replace });
  };

  // ── Search box: local while typing, committed to the URL on a pause ───────
  // Committed with REPLACE: a keystroke is not a navigation, and pushing one
  // history entry per typing pause would make Back walk the query backwards
  // instead of leaving the page. Sort/filter/page clicks push normally.
  const [searchText, setSearchText] = useState(query.q);
  const committedSearchRef = useRef(query.q);
  useEffect(() => {
    if (query.q === committedSearchRef.current) return;
    // The URL changed under us (Back/Forward, or the sort-heal above) — adopt it.
    committedSearchRef.current = query.q;
    setSearchText(query.q);
  }, [query.q]);
  useEffect(() => {
    if (searchText.trim() === committedSearchRef.current) return;
    const timer = setTimeout(() => {
      committedSearchRef.current = searchText.trim();
      patchQuery({ q: searchText }, true);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Top-level slug from the URL (first path segment) + whether this is a nested
  // subcategory page. Drive the session "shell" memo so the breadcrumb, title,
  // and chips render synchronously on a sibling nav instead of disappearing into
  // a skeleton + re-animating on every remount (the page is pathname-keyed).
  // NOTE: on the transient flat `/category/:childSlug` URL (pre-canonical-
  // redirect) this is the CHILD slug; the `shell` memo below is category-data-
  // primary in that state, so it doesn't rely on topSlug being the parent.
  const topSlug = useMemo(() => {
    const m = location.pathname.match(/^\/category\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);
  const onChild = !!childSlug;

  // Stable top-level identity + sibling list. Prefer freshly-loaded data; fall
  // back to the session memo while a sibling-nav remount's own fetch is pending.
  const shell: CategoryShell | null = useMemo(() => {
    if (chrome) {
      if (isParent) {
        return { name: chrome.name, slug: chrome.slug, icon: chrome.icon, children: chrome.children };
      }
      if (chrome.parent) {
        const p = chrome.parent;
        return { name: p.name, slug: p.slug, icon: p.icon, children: p.children };
      }
    }
    return (topSlug ? getCategoryShell(topSlug) : undefined) ?? null;
  }, [chrome, isParent, topSlug]);

  // The current page's label + icon (breadcrumb current crumb + page title): the
  // matching sibling on a child page, the top-level itself on a parent page.
  const currentSub = useMemo(() => {
    if (!shell) return null;
    if (onChild) return shell.children.find((c) => c.slug === childSlug) ?? null;
    return { id: shell.slug, name: shell.name, slug: shell.slug, icon: shell.icon };
  }, [shell, onChild, childSlug]);

  // Display name/icon for the current crumb + the H1. Falls back to the loaded
  // category if a deep-linked child slug isn't in the cached sibling list, so the
  // title never silently blanks (currentSub null while shell is non-null).
  const titleName = currentSub?.name ?? chrome?.name ?? '';
  const titleIcon = currentSub?.icon ?? chrome?.icon ?? null;

  // Persist the shell once real data lands, so the next sibling nav has it sync.
  useEffect(() => {
    if (shell && chrome) setCategoryShell(shell);
  }, [shell, chrome]);

  // ── Facets: every count and every filter option on the page ──────────────
  // Counts used to be derived from the loaded rows, which is why they agreed
  // with the truncation instead of contradicting it. They are server-side now,
  // each list computed with every filter applied EXCEPT its own, so choosing a
  // manufacturer never collapses the manufacturer list to that one choice.
  const facets = rows?.facets ?? null;
  const totalUnfiltered = facets?.total_unfiltered ?? null;

  const mfgOptions = useMemo<FilterOption[]>(
    () => (facets?.manufacturers ?? []).map(m => ({ value: m.name, label: m.name, count: m.count })),
    [facets],
  );
  const subOptions = useMemo<FilterOption[]>(
    () => (facets?.subs ?? []).map(s => ({ value: s.slug, label: s.name, count: s.count })),
    [facets],
  );

  // A checked box IS the filter: nothing checked = the ABSENT param = every
  // part, exactly as the wire contract reads. The page used to pre-check
  // everything, because the options were whatever 500 loaded rows happened to
  // contain. The list is the complete server facet now — hundreds of
  // manufacturers on a big category — where pre-checking makes the ordinary
  // intent ("only TI") unreachable without ~400 clicks, and a selection of
  // "everything except one" would ship ~400 URL params straight into nginx's
  // header-buffer limit. So: check what you want, Clear to drop it.
  const mfgSelected = useMemo(() => new Set(query.mfg), [query.mfg]);
  const subSelected = useMemo(() => new Set(query.sub), [query.sub]);

  const subCounts = useMemo(() => {
    const map = new Map<string, number>();
    // The shell's own stamped counts first — the only source on a LEAF page,
    // where the sibling facet list is empty by design (a leaf has no sub
    // filter) — overlaid by the fresher, filter-aware facet counts.
    const siblings = isParent ? chrome?.children : chrome?.parent?.children;
    for (const s of siblings ?? []) {
      if (s.parts_count != null && s.parts_count > 0) map.set(s.slug, s.parts_count);
    }
    for (const s of facets?.subs ?? []) map.set(s.slug, s.count);
    return map;
  }, [facets, chrome, isParent]);

  const subSlugToName = useMemo(() => {
    if (!chrome) return {};
    const children = isParent ? chrome.children : (chrome.parent?.children ?? []);
    return Object.fromEntries(children.map(s => [s.slug, s.name]));
  }, [chrome, isParent]);

  const subSlugToIcon = useMemo(() => {
    if (!chrome) return {};
    const children = isParent ? chrome.children : (chrome.parent?.children ?? []);
    return Object.fromEntries(children.map(s => [s.slug, s.icon]));
  }, [chrome, isParent]);

  const sort: SortState = { col: query.sort, dir: query.dir };
  const setSort = (next: SortState) => patchQuery({ sort: next.col, dir: next.dir });

  const handlePageChange = (next: number) => {
    patchQuery({ page: next });
    setTimeout(() => {
      document.getElementById('category-parts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const categoryName = chrome?.name ?? '';

  // Same builder the build-time prerender uses for this route's static HTML
  // (scripts/seoPrerender.ts), so the tags helmet swaps in on mount are the
  // tags the crawler already read.
  const seo = chrome && canonicalPath
    ? categorySeo({
        name: categoryName,
        canonicalPath,
        description: chrome.description,
        parent: chrome.parent,
      })
    : null;

  // Canonicalize the URL: a subcategory reached via the flat `/category/:slug`
  // (legacy/bookmarked/search link) or via a wrong parent slug redirects to its
  // true nested path. Top-level categories already match → no-op.
  //
  // Effect-based (NOT a render-phase `<Navigate>`): PublicLayout wraps the
  // Outlet in `<ErrorBoundary key={location.pathname}>`, and the redirect
  // changes the pathname — i.e. that key. A `<Navigate>` returned from render
  // runs its navigate() in the rendered child's mount effect, which the keyed
  // remount dropped before it fired (category loaded, page rendered empty, URL
  // never changed — 2026-06-03). navigate() from this component's own stable
  // effect commits reliably. `location.search` rides along so a shared
  // ?sort=/?mfg= link survives the canonicalisation.
  useEffect(() => {
    if (needsCanonicalRedirect && canonicalPath) {
      navigate(`${canonicalPath}${location.search}`, { replace: true });
    }
  }, [needsCanonicalRedirect, canonicalPath, location.search, navigate]);

  // While a redirect is pending, show the skeleton (not the page content at the
  // soon-to-be-replaced URL) so there's no flash of the wrong canonical.
  const busy = loading || needsCanonicalRedirect;
  // The rows on screen answer a DIFFERENT query than the one in flight (a sort,
  // a filter, a page — with nothing cached for it): dim what's there rather than
  // tearing the page down to skeletons, which would flash the layout on every
  // click. A revalidation of the rows already shown stays invisible.
  const updating = fetching && !busy && rows != null && rowsState?.key !== rowsKey;

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      {seo && <PageHead seo={seo} />}
      <div className={styles.categoryHeader}>
        <div className={styles.headerInner}>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            <Link to="/" className={styles.breadcrumbLink}>Home</Link>
            <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
            {shell && !needsCanonicalRedirect ? (
              <>
                {onChild && (
                  <>
                    <Link to={`/category/${shell.slug}`} className={styles.breadcrumbLink}>
                      {shell.name}
                    </Link>
                    <span className={styles.breadcrumbSep} aria-hidden="true">/</span>
                  </>
                )}
                <span className={styles.breadcrumbCurrent}>{titleName}</span>
              </>
            ) : busy ? (
              <SkeletonLoader width="120px" height="16px" borderRadius="4px" />
            ) : null}
          </nav>

          {shell && !needsCanonicalRedirect ? (
            <>
              <div className={styles.titleRow}>
                <h1 className={styles.title}>
                  {titleIcon && <span className={styles.titleIcon}><Icon name={titleIcon} /></span>}
                  {titleName}
                </h1>
              </div>
              {rows && chrome ? (
                // The TRUE total for the current filters — server-counted, so it
                // no longer agrees with a 500-row truncation. With a filter on,
                // the category's full size stays visible beside it.
                <p className={styles.headerMeta}>
                  <span className={styles.headerMetaMono}>
                    {rows.parts.total.toLocaleString()}
                  </span>
                  {filtersActive && totalUnfiltered != null && totalUnfiltered !== rows.parts.total && (
                    <>
                      {' of '}
                      <span className={styles.headerMetaMono}>
                        {totalUnfiltered.toLocaleString()}
                      </span>
                    </>
                  )}
                  {' parts'}
                  {isParent && (
                    <>
                      <span className={styles.headerDot}>&middot;</span>
                      <span className={styles.headerMetaMono}>{chrome.children.length}</span> subcategories
                    </>
                  )}
                </p>
              ) : (
                // Title is instant from the shell; only the parts count waits on
                // the fetch. 24px matches the loaded meta line so nothing shifts.
                <SkeletonLoader width="140px" height="24px" borderRadius="4px" />
              )}
            </>
          ) : busy ? (
            // Cold (parent unknown): reserve the loaded title (42px) + meta (24px)
            // heights so the banner below doesn't jump when content resolves.
            <>
              <SkeletonLoader width="250px" height="42px" borderRadius="4px" />
              <SkeletonLoader width="140px" height="24px" borderRadius="4px" />
            </>
          ) : null}
        </div>
      </div>

      {/* Sticky subcategory pill-bar — renders synchronously from the session
          shell on a sibling nav (no skeleton, no re-animation). The skeleton bar
          (6 pills that wrap like the real chips) shows only on a cold first
          visit to a parent whose shell isn't cached yet. Counts come from the
          server facets now, not from the rows that happened to load. */}
      {shell && !needsCanonicalRedirect ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            {/* >6 subs on mobile: the chip bar collapses to a 44px trigger +
                bottom-sheet index (constant height at any count). Desktop and
                small families keep the chips. */}
            {shell.children.length > 6 && (
              <SubcatSheet
                familyName={shell.name}
                familySlug={shell.slug}
                subcategories={shell.children}
                activeSlug={onChild ? childSlug ?? null : null}
                counts={subCounts}
                // Only the parent page knows the family's true size; on a leaf
                // the facets describe the leaf, and quoting that as the family
                // total is the lie the old client-side count told.
                totalParts={isParent ? totalUnfiltered : null}
              />
            )}
            <div
              className={`${styles.chipBar} ${shell.children.length > 6 ? styles.chipBarWideOnly : ''}`}
            >
              {onChild ? (
                <SubcategoryChips
                  subcategories={shell.children}
                  parentSlug={shell.slug}
                  activeSlug={childSlug}
                />
              ) : (
                <>
                  {/* On the parent page, "All" is the page you're on. The
                      subcategory chips are real <Link>s to each child's nested
                      page — crawlable anchors, middle-clickable, and the fix
                      for the 2026-06-03 "subcategories only filter, never
                      navigate / child pages unreachable" bug. */}
                  <Link
                    to={categoryPath(shell.slug)}
                    className={`${styles.chip} ${styles.chipActive}`}
                    aria-current="page"
                  >
                    <span>All</span>
                    {totalUnfiltered != null && totalUnfiltered > 0 && (
                      <span className={styles.chipCount}>{totalUnfiltered.toLocaleString()}</span>
                    )}
                  </Link>
                  {shell.children.map((s) => {
                    const count = subCounts.get(s.slug) ?? null;
                    return (
                      <Link
                        key={s.slug}
                        to={categoryPath(s.slug, shell.slug)}
                        className={styles.chip}
                      >
                        <Icon name={s.icon} />
                        <span>{s.name}</span>
                        {count != null && count > 0 && (
                          <span className={styles.chipCount}>{count.toLocaleString()}</span>
                        )}
                      </Link>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </nav>
      ) : busy ? (
        <nav className={styles.stickySubnav} aria-label="Subcategories">
          <div className={styles.subnavInner}>
            {/* 6 pills (All + 5 siblings) at ~real chip widths so the skeleton
                wraps to the same rows as the loaded chips (no min-height — that
                stretched single-row chips on wide screens, 2026-06-08). */}
            <div className={styles.chipBar}>
              <SkeletonLoader width="56px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="240px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="250px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="240px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="230px" height="30px" borderRadius="20px" />
              <SkeletonLoader width="140px" height="30px" borderRadius="20px" />
            </div>
          </div>
        </nav>
      ) : null}

      <div className={styles.contentWide}>
        {error && <p className={styles.error}>{error}</p>}

        {/* Platinum Category Sponsor band — below the breadcrumb + sticky sub-nav,
            in the content-area top position. Sourced from the TOP-LEVEL category's
            /partners (via CategoryPartnersBanner), so the SAME board shows on the
            parent page and every subpage. Always present (Open-Placement fallback
            when unsold). */}
        <CategoryPartnersBanner />

        {busy ? (
          <>
            {/* Tier-row skeleton reserves the real ~340px height so the always-
                present band above doesn't snap down when content resolves. We
                can't yet know parent-vs-child, so reserve the (taller) subpage
                layout; on a parent it collapses to nothing once loaded. */}
            <div className={styles.tierRowSkeleton} aria-hidden="true">
              <SkeletonLoader width="100%" height="340px" borderRadius="14px" />
              <SkeletonLoader width="100%" height="340px" borderRadius="8px" />
            </div>
            <div className={styles.tableSkeleton}>
              <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
              ))}
            </div>
          </>
        ) : chrome ? (
          <>
            {/* The buyer's receipt, on the way back from Stripe — the same
                placement-ticket panel they bought through, in its receipt
                state (was a dismissible strip above the tier row). The
                `welcome` param is already stripped from the URL by the mount
                effect above; closing just retires the panel. */}
            {welcome && (
              <SilverCheckoutModal
                variant="receipt"
                categoryName={chrome.name}
                onClose={() => setWelcome(false)}
              />
            )}
            {/* SUBPAGES ONLY: the tier row — Silver directory (main) beside the
                Gold-tier SponsorBlock (aside). Parent pages skip it (no per-
                subcategory Gold/Silver), so parts span full width directly. */}
            {chrome.parent != null && (
              <div className={styles.tierRow}>
                <div className={styles.tierRowMain}>
                  <SilverPartners
                    suppliers={chrome.silver ?? []}
                    categoryName={chrome.name}
                    categoryId={chrome.id}
                  />
                </div>
                <aside className={styles.tierRowSide}>
                  <SponsorBlock sponsor={chrome.sponsor} />
                </aside>
              </div>
            )}

            {/* The page's only unique indexable prose — the parts table is
                data and everything above it is chrome. Same Category.description
                that feeds <meta description> + the CollectionPage JSON-LD.
                Sits BELOW the tier row so that landing it can never displace
                the always-present Platinum band or the sponsor boards; only
                the parts table (already a skeleton→content swap) moves down.
                Today only the 15 top-level categories carry copy — every
                subcategory row is NULL — so the block renders nothing at all
                rather than reserving an empty box. */}
            {chrome.description && (
              <section className={styles.about} aria-labelledby="category-about">
                <h2 id="category-about" className={styles.aboutTitle}>
                  About {chrome.name}
                </h2>
                <p className={styles.aboutBody}>{chrome.description}</p>
              </section>
            )}

            <section id="category-parts" className={styles.partsFull}>
              {rows ? (
                <div className={styles.partsArea}>
                  <div
                    className={`${styles.partsBody} ${updating ? styles.partsBodyDim : ''}`}
                    aria-busy={updating ? true : undefined}
                  >
                    <PartsTable
                      parts={rows.parts.items}
                      sort={sort}
                      setSort={setSort}
                      skuSearch={searchText}
                      setSkuSearch={setSearchText}
                      filtersActive={filtersActive}
                      mfgOptions={mfgOptions}
                      mfgSelected={mfgSelected}
                      setMfgSelected={next => patchQuery({ mfg: Array.from(next) })}
                      subOptions={isParent ? subOptions : undefined}
                      subSelected={isParent ? subSelected : undefined}
                      setSubSelected={
                        isParent ? next => patchQuery({ sub: Array.from(next) }) : undefined
                      }
                      onClearFilters={
                        filtersActive
                          ? () => {
                              setSearchText('');
                              committedSearchRef.current = '';
                              patchQuery({ q: '', mfg: [], sub: [] });
                            }
                          : undefined
                      }
                      subSlugToName={subSlugToName}
                      subSlugToIcon={subSlugToIcon}
                    />

                    {rows.parts.pages > 1 && (
                      <Pagination
                        page={rows.parts.page}
                        pages={rows.parts.pages}
                        onChange={handlePageChange}
                      />
                    )}
                  </div>
                  {/* Decorative, and aria-hidden on purpose: `aria-busy` above
                      is what assistive tech reads. A role="status" mounted at
                      the same instant as its own text is not reliably announced
                      anyway (a live region has to exist BEFORE it changes). */}
                  {updating && (
                    <div className={styles.updatingOverlay} aria-hidden="true">
                      <span className={styles.updatingPill}>Updating&hellip;</span>
                    </div>
                  )}
                </div>
              ) : (
                // Chrome is cached but this query's rows are not (a sibling nav,
                // or a deep link to page 5). Only the table area waits, and it
                // reserves the real row heights so nothing below it jumps.
                <div className={styles.tableSkeleton}>
                  <SkeletonLoader width="100%" height="40px" borderRadius="4px" />
                  {Array.from({ length: 8 }).map((_, i) => (
                    <SkeletonLoader key={i} width="100%" height="48px" borderRadius="4px" />
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </motion.div>
  );
}
