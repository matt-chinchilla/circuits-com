import { Link, useNavigate } from 'react-router-dom';
import { api } from '@public/services/api';
import Icon from '@shared/components/Icon';
import styles from './CategoryCard.module.scss';

// The design-kit cat-card, shared by the homepage grid and the search results
// category section (the kit's SrCatCard reuses the Home markup verbatim).
// Purely presentational: consumers adapt their own data shape (Category vs
// SearchCategoryHit) into `subs` links.

export interface CategoryCardSub {
  key: string;
  name: string;
  to: string;
}

interface CategoryCardProps {
  to: string;
  icon: string | null;
  name: string;
  subs: CategoryCardSub[];
  /** Rendered as the neon head pill when > 0. */
  count?: number;
  /** Staggered entrance index (homepage); omit to render without entrance. */
  index?: number;
  /** Category slug to warm (route chunk + API cache) on pointer hover. */
  prefetchSlug?: string;
}

// Six chips maximum, per the kit: past that the sixth becomes "More…", which
// does what the card's empty space does — opens the category.
const MAX_SUBS = 6;

export default function CategoryCard({
  to,
  icon,
  name,
  subs,
  count,
  index,
  prefetchSlug,
}: CategoryCardProps) {
  const navigate = useNavigate();
  const overflow = subs.length > MAX_SUBS;
  const shown = overflow ? subs.slice(0, MAX_SUBS - 1) : subs;

  return (
    <div
      className={index != null ? `${styles.card} ${styles.cardEnter}` : styles.card}
      // Cap the stagger: with a full grid a linear delay left the last cards
      // invisible for over a second (review-caught on the old FM version).
      style={index != null ? { animationDelay: `${Math.min(index, 12) * 0.05}s` } : undefined}
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        navigate(to);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(to);
      }}
      onMouseEnter={
        prefetchSlug
          ? () => {
              import('@public/pages/category').catch(() => {});
              api.prefetchCategory(prefetchSlug);
            }
          : undefined
      }
    >
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name={icon} />
        </span>
        <h3 className={styles.name}>{name}</h3>
        {count != null && count > 0 && (
          <span className={styles.count} aria-label={`${count.toLocaleString()} parts`}>
            {count.toLocaleString()}
          </span>
        )}
      </div>
      {subs.length > 0 && (
        <div className={styles.subcategories}>
          {shown.map((sub) => (
            <Link key={sub.key} to={sub.to} className={styles.pill}>
              {sub.name}
            </Link>
          ))}
          {overflow && (
            <Link to={to} className={`${styles.pill} ${styles.pillMore}`}>
              More&hellip;
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
