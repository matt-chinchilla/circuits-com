import { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useSearch } from '../../hooks/useSearch';
import styles from './SearchBar.module.scss';

interface SearchBarProps {
  variant?: 'hero' | 'compact' | 'nav';
  initialQuery?: string;
}

export default function SearchBar({ variant = 'hero', initialQuery = '' }: SearchBarProps) {
  const navigate = useNavigate();
  const { query, setQuery, results, loading } = useSearch(300);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Seed with initialQuery on mount
  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
    }
  }, [initialQuery, setQuery]);

  // Open dropdown when results arrive (hero variant only)
  useEffect(() => {
    if (variant === 'hero' && results && (results.categories.length > 0 || results.suppliers.length > 0)) {
      setOpen(true);
    } else if (!results) {
      setOpen(false);
    }
  }, [results, variant]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed) {
        setOpen(false);
        navigate(`/search?q=${encodeURIComponent(trimmed)}`);
      }
    },
    [query, navigate]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  };

  const hasResults =
    results && (results.categories.length > 0 || results.suppliers.length > 0);

  const showDropdown = variant === 'hero' && open && hasResults;

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
            if (variant === 'hero' && hasResults) setOpen(true);
          }}
          placeholder={variant === 'nav' ? 'Search components...' : 'Search by keywords, part numbers, categories...'}
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

      {showDropdown && results && (
        <div className={styles.dropdown} role="listbox" aria-label="Search suggestions">
          {results.categories.length > 0 && (
            <div className={styles.dropdownSection}>
              <p className={styles.sectionHeader}>Categories</p>
              {results.categories.slice(0, 5).map((cat) => (
                <Link
                  key={cat.id}
                  to={`/category/${cat.slug}`}
                  className={styles.dropdownItem}
                  role="option"
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.itemIcon} aria-hidden="true">
                    {cat.icon}
                  </span>
                  <span className={styles.itemLabel}>{cat.name}</span>
                </Link>
              ))}
            </div>
          )}

          {results.suppliers.length > 0 && (
            <div className={styles.dropdownSection}>
              <p className={styles.sectionHeader}>Suppliers</p>
              {results.suppliers.slice(0, 5).map((sup) => (
                <Link
                  key={sup.id}
                  to={`/search?q=${encodeURIComponent(sup.name)}`}
                  className={styles.dropdownItem}
                  role="option"
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.itemIcon} aria-hidden="true">🏭</span>
                  <span className={styles.itemLabel}>{sup.name}</span>
                  {sup.is_featured && (
                    <span className={styles.featuredBadge}>Featured</span>
                  )}
                </Link>
              ))}
            </div>
          )}

          <div className={styles.dropdownFooter}>
            <button
              type="button"
              className={styles.seeAllBtn}
              onClick={handleSubmit as unknown as React.MouseEventHandler}
            >
              See all results for &ldquo;{query}&rdquo; →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
