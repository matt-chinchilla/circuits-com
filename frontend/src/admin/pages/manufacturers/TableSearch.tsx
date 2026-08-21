// Debounced table search that OWNS the raw keystrokes (efficiency finding:
// with the input state on the page, every keypress re-rendered all 50 table
// rows — URL parses, Intl formats, style objects — for zero visible change
// until the debounce settled). The page only hears the settled value.
//
// Co-owned by the two CatalogSwitch lists, like CatalogSwitch itself.

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  placeholder: string;
  ariaLabel: string;
  /** Receives the TRIMMED, debounced query. */
  onQuery: (q: string) => void;
  /** The page's toolbar styles — inlineSearch + searchClear class names. */
  className: string;
  clearClassName: string;
}

export default function TableSearch({
  placeholder,
  ariaLabel,
  onQuery,
  className,
  clearClassName,
}: Props) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const t = setTimeout(() => onQuery(value.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className={className}>
      <Search size={14} strokeWidth={2} />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={ariaLabel}
      />
      {value && (
        <button
          type="button"
          className={clearClassName}
          onClick={() => setValue('')}
          aria-label="Clear search"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
