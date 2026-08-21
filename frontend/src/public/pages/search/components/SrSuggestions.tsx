// "Did you mean" chip row for the zero-result state — kit parity
// (Search.jsx suggestions block, sponsor.css .search-empty-sugg*). Chips are
// white-filled with dark --fg1 ink (spec OVERRIDE: never accent text on a
// light card), dashed accent border, a 24px lettermark pad (distributor /
// manufacturer) or Phosphor icon (category), and a tiny mono kind tag.
// Clicking re-runs the search with the suggested term via the URL.
//
// Styles come from SearchPage.module.scss — this component is part of the
// page surface, not a reusable widget.
import { Link } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import type { SearchSuggestion } from '@public/types/search';
import { srInitials } from '../lib/srFormat';
import styles from '../SearchPage.module.scss';

export default function SrSuggestions({ suggestions }: { suggestions: SearchSuggestion[] }) {
  return (
    <div className={styles.sugg}>
      <span className={styles.suggLabel}>DID YOU MEAN</span>
      <div className={styles.suggChips}>
        {suggestions.map((s) => (
          <Link
            key={`${s.kind}:${s.term}`}
            className={styles.suggChip}
            to={`/search?q=${encodeURIComponent(s.term)}`}
          >
            {s.kind === 'category' && s.icon != null ? (
              <Icon name={s.icon} />
            ) : (
              <span className={styles.suggPad} aria-hidden="true">
                {srInitials(s.term)}
              </span>
            )}
            {s.term}
            <span className={styles.suggKind}>{s.kind}</span>
            <span aria-hidden="true">{'\u2192'}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
