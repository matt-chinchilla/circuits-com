import styles from './Pagination.module.scss';

interface PaginationProps {
  page: number;
  pages: number;
  onChange: (next: number) => void;
  // Window of numbered links to show around the current page on desktop.
  // Default 1 → render [first, ..., cur-1, cur, cur+1, ..., last].
  windowSize?: number;
}

// Builds the list of page tokens to render. Number = numbered link;
// 'ellipsis-L' / 'ellipsis-R' = gap markers (rendered as "…").
// Keeps first and last pages always visible.
function buildPageTokens(page: number, pages: number, windowSize: number): (number | 'ellipsis-L' | 'ellipsis-R')[] {
  if (pages <= 1) return [1];
  const tokens: (number | 'ellipsis-L' | 'ellipsis-R')[] = [];
  const left = Math.max(2, page - windowSize);
  const right = Math.min(pages - 1, page + windowSize);

  tokens.push(1);
  if (left > 2) tokens.push('ellipsis-L');
  for (let p = left; p <= right; p++) tokens.push(p);
  if (right < pages - 1) tokens.push('ellipsis-R');
  if (pages > 1) tokens.push(pages);
  return tokens;
}

export default function Pagination({ page, pages, onChange, windowSize = 1 }: PaginationProps) {
  if (pages <= 1) return null;
  const tokens = buildPageTokens(page, pages, windowSize);
  const canPrev = page > 1;
  const canNext = page < pages;

  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => canPrev && onChange(page - 1)}
        disabled={!canPrev}
        aria-label="Previous page"
      >
        ← Prev
      </button>

      {/* Mobile-only condensed indicator (numbered list is hidden under bp-mobile via CSS) */}
      <span className={styles.mobileIndicator}>
        Page {page} of {pages}
      </span>

      <ol className={styles.pageList}>
        {tokens.map((t, i) =>
          typeof t === 'number' ? (
            <li key={`p-${t}`}>
              <button
                type="button"
                className={`${styles.pageBtn} ${t === page ? styles.active : ''}`}
                onClick={() => onChange(t)}
                aria-current={t === page ? 'page' : undefined}
                aria-label={`Page ${t}`}
              >
                {t}
              </button>
            </li>
          ) : (
            <li key={`e-${i}`} className={styles.ellipsis} aria-hidden="true">
              …
            </li>
          ),
        )}
      </ol>

      <button
        type="button"
        className={styles.navBtn}
        onClick={() => canNext && onChange(page + 1)}
        disabled={!canNext}
        aria-label="Next page"
      >
        Next →
      </button>
    </nav>
  );
}
