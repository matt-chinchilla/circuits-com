import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@public/services/api';
import type { SearchResultsV2, SearchSupplierHit } from '@public/types/search';
import { categoryPath } from '@shared/utils/categoryPath';
import { displayHost } from '@shared/utils/url';
import Icon from '@shared/components/Icon';
import styles from './SearchBar.module.scss';

interface SearchBarProps {
  variant?: 'hero' | 'compact' | 'nav';
  /** Fires when the dropdown's mounted-visibility changes (before paint, only
   *  on actual transitions), with a guaranteed final `false` on unmount. The
   *  hero wires this to stack itself above subsequent content while open. */
  onDropdownOpenChange?: (open: boolean) => void;
}

// Kit-parity section caps: Parts (5) → Distributors (3) → Categories (3).
const PARTS_CAP = 5;
const DISTRIBUTORS_CAP = 3;
const CATEGORIES_CAP = 3;

/** dd-mark pad letter — kit-pinned to 1 char, deliberately NOT
 *  @shared/utils/lettermark (1–2 chars) or srFormat.srInitials. */
function padLetter(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}

// Tier and website are both nullable — join only what exists, never a
// dangling separator, never the string "null".
function distributorSubLine(sup: SearchSupplierHit): string {
  const tier = sup.tier ? `${sup.tier.charAt(0).toUpperCase()}${sup.tier.slice(1)} ` : '';
  const host = displayHost(sup.website);
  return host ? `${tier}distributor · ${host}` : `${tier}distributor`;
}

export default function SearchBar({
  variant = 'hero',
  onDropdownOpenChange,
}: SearchBarProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultsV2 | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Debounced typeahead. suggest=0 always: zero-result keystrokes must never
  // pay the server's fuzzy-recovery pipeline (spec §1.3/§3). compact=1 trims
  // the payload to the dropdown's own caps — the full 20/12-cap enrichment
  // was wasted work per keystroke.
  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchV2(query, { suggest: 0, compact: 1 })
        .then((data) => {
          if (!cancelled) setResults(data);
        })
        .catch(() => {
          if (!cancelled) setResults(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const parts = results?.parts.slice(0, PARTS_CAP) ?? [];
  const distributors = results?.suppliers.slice(0, DISTRIBUTORS_CAP) ?? [];
  const categories = results?.categories.slice(0, CATEGORIES_CAP) ?? [];
  const hasResults = parts.length > 0 || distributors.length > 0 || categories.length > 0;
  const showDropdown = open && hasResults;

  // Notify the host of mounted-visibility transitions. Layout effect on the
  // DERIVED boolean: it commits before paint (never an after-paint class
  // flash on the hero) and catches every open/close source — handler
  // setOpen, results arriving, results clearing.
  const notifyRef = useRef(onDropdownOpenChange);
  const lastSentRef = useRef(false);
  useLayoutEffect(() => {
    notifyRef.current = onDropdownOpenChange;
  });
  useLayoutEffect(() => {
    if (showDropdown !== lastSentRef.current) {
      lastSentRef.current = showDropdown;
      notifyRef.current?.(showDropdown);
    }
  }, [showDropdown]);
  useLayoutEffect(
    () => () => {
      // Guaranteed final false so an unmounting open dropdown can't strand
      // the host's ddOpen state.
      if (lastSentRef.current) {
        lastSentRef.current = false;
        notifyRef.current?.(false);
      }
    },
    []
  );

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        e.target instanceof Node &&
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const submitSearch = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed) {
      setOpen(false);
      navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    }
  }, [query, navigate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitSearch();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setOpen(true);
  };

  return (
    <div
      ref={wrapperRef}
      className={[styles.searchWrapper, styles[variant]].filter(Boolean).join(' ')}
    >
      <form
        onSubmit={handleSubmit}
        className={styles.searchForm}
        role="search"
        aria-label="Site search"
      >
        <input
          type="search"
          value={query}
          onChange={handleChange}
          onFocus={() => {
            if (hasResults) setOpen(true);
          }}
          placeholder="Search Circuits..."
          className={styles.searchInput}
          aria-label="Search query"
          aria-autocomplete="list"
          aria-expanded={showDropdown ? 'true' : 'false'}
          autoComplete="off"
        />
        <button
          type="submit"
          className={styles.searchButton}
          aria-label="Submit search"
        >
          {loading ? (
            <span className={styles.spinner} aria-hidden="true" />
          ) : (
            'SEARCH'
          )}
        </button>
      </form>

      {showDropdown && (
        <div className={styles.dropdown} role="listbox" aria-label="Search suggestions">
          {parts.length > 0 && (
            <div className={styles.dropdownSection}>
              <p className={styles.sectionHeader}>Parts</p>
              {parts.map((part) => {
                const subLine = [part.description, part.manufacturer_name]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <Link
                    key={part.id}
                    to={`/part/${part.slug}`}
                    className={styles.dropdownItem}
                    role="option"
                    onMouseEnter={() => {
                      import("@public/pages/part").catch(() => {});
                    }}
                    onClick={() => setOpen(false)}
                  >
                    <span className={styles.partPad} aria-hidden="true">
                      <Icon name={part.category_icon} />
                    </span>
                    <span className={styles.itemText}>
                      <span className={styles.partSku}>{part.sku}</span>
                      {subLine && <span className={styles.partDesc}>{subLine}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {distributors.length > 0 && (
            <div className={styles.dropdownSection}>
              <p className={styles.sectionHeader}>Distributors</p>
              {distributors.map((sup) => (
                <Link
                  key={sup.id}
                  to="/join"
                  className={styles.dropdownItem}
                  role="option"
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.ddMark} aria-hidden="true">
                    {padLetter(sup.name)}
                  </span>
                  <span className={styles.itemText}>
                    <span className={styles.supName}>{sup.name}</span>
                    <span className={styles.supSub}>{distributorSubLine(sup)}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}

          {categories.length > 0 && (
            <div className={styles.dropdownSection}>
              <p className={styles.sectionHeader}>Categories</p>
              {categories.map((cat) => (
                <Link
                  key={cat.id}
                  to={categoryPath(cat.slug, cat.parent_slug)}
                  className={styles.dropdownItem}
                  role="option"
                  onMouseEnter={() => {
                    import("@public/pages/category").catch(() => {});
                    api.prefetchCategory(cat.slug);
                  }}
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.itemIcon} aria-hidden="true">
                    <Icon name={cat.icon} />
                  </span>
                  <span className={styles.itemLabel}>{cat.name}</span>
                </Link>
              ))}
            </div>
          )}

          <div className={styles.dropdownFooter}>
            <button
              type="button"
              className={styles.seeAllBtn}
              onClick={submitSearch}
            >
              See all results for &ldquo;{query}&rdquo; &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
