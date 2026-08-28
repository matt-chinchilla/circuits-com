import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { PublicPart } from '@public/types/part';
import { formatPrice } from '@public/services/format';
import Icon from '@shared/components/Icon';
import ColumnHeader from './ColumnHeader';
import type { FilterOption, SortState } from './ColumnHeader';
import styles from './PartsTable.module.scss';

interface PartsTableProps {
  parts: PublicPart[];
  sort: SortState;
  setSort: (s: SortState) => void;
  skuSearch: string;
  setSkuSearch: (v: string) => void;
  /**
   * Is the server currently narrowing the result set? Emptiness means two
   * different things — "your filters match nothing" and "this category holds
   * no parts yet" — and only the page knows which, now that the rows arrive
   * pre-filtered.
   */
  filtersActive: boolean;
  /**
   * Present only while `filtersActive`. Without it, a filter that matches
   * nothing is a DEAD END: the empty state replaces the table, the column
   * headers go with it, and the popover that could undo the filter is gone.
   */
  onClearFilters?: () => void;
  mfgOptions: FilterOption[];
  mfgSelected: Set<string>;
  setMfgSelected: (v: Set<string>) => void;
  /** Parent pages only: the Category column. `undefined` on a leaf. */
  subOptions?: FilterOption[];
  subSelected?: Set<string>;
  setSubSelected?: (v: Set<string>) => void;
  subSlugToName?: Record<string, string>;
  subSlugToIcon?: Record<string, string>;
}

const rowVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.03, duration: 0.35, ease: 'easeOut' as const },
  }),
};

export default function PartsTable({
  parts, sort, setSort,
  skuSearch, setSkuSearch,
  filtersActive, onClearFilters,
  mfgOptions, mfgSelected, setMfgSelected,
  subOptions, subSelected, setSubSelected,
  subSlugToName, subSlugToIcon,
}: PartsTableProps) {
  if (parts.length === 0) {
    // "No parts match the filters" is a LIE on a category that simply has no
    // inventory yet (the default state of the 2026-08-16 expansion pages) —
    // only claim filtering when the request actually carried one.
    return (
      <div className={styles.empty}>
        <p>
          {filtersActive
            ? 'No parts match the current filters.'
            : 'No parts listed here yet — inventory for this category is on its way.'}
        </p>
        {filtersActive && onClearFilters && (
          <button type="button" className={styles.emptyReset} onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </div>
    );
  }

  // Driven by the PAGE's parent/leaf knowledge, not by whether the facet list
  // has arrived — deriving it from option count made the column appear a frame
  // late and shift the table.
  const showSubColumn = subOptions != null && subSelected != null && setSubSelected != null;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <ColumnHeader
              label="SKU" sortKey="sku"
              sort={sort} setSort={setSort}
              hasSearch search={skuSearch} setSearch={setSkuSearch}
            />
            <ColumnHeader
              label="Description" sortKey="desc" hideClass={styles.hideDesc}
              sort={sort} setSort={setSort}
            />
            <ColumnHeader
              label="Manufacturer" sortKey="mfg"
              sort={sort} setSort={setSort}
              filterOptions={mfgOptions}
              filterSelected={mfgSelected}
              setFilterSelected={setMfgSelected}
            />
            {showSubColumn && (
              <ColumnHeader
                label="Category" sortKey="sub" hideClass={styles.hideMobile}
                sort={sort} setSort={setSort}
                filterOptions={subOptions}
                filterSelected={subSelected}
                setFilterSelected={setSubSelected}
              />
            )}
            <ColumnHeader label="Qty 1" sortKey="qty1" numeric sort={sort} setSort={setSort} />
            <ColumnHeader label="Qty 10" sortKey="qty10" numeric sort={sort} setSort={setSort} />
            <ColumnHeader label="Qty 100" sortKey="qty100" numeric sort={sort} setSort={setSort} />
            <ColumnHeader label="Qty 1k" sortKey="qty1k" numeric sort={sort} setSort={setSort} />
          </tr>
        </thead>
        <tbody>
          {parts.map((part, i) => (
            <motion.tr
              key={part.id}
              className={styles.row}
              custom={i}
              variants={rowVariants}
              initial="hidden"
              animate="visible"
            >
              <td className={styles.td}>
                <Link to={`/part/${part.id}`} className={styles.skuLink}>
                  {part.category_icon && <span className={styles.partIcon}><Icon name={part.category_icon} /></span>}
                  {part.sku}
                </Link>
              </td>
              <td className={`${styles.td} ${styles.tdDesc}`}>
                <span className={styles.description}>{part.description || '—'}</span>
              </td>
              <td className={styles.td}>
                <span className={styles.manufacturer}>{part.manufacturer_name}</span>
              </td>
              {showSubColumn && (
                <td className={`${styles.td} ${styles.tdSub}`}>
                  <span className={styles.subCell}>
                    {subSlugToIcon?.[part.sub_slug ?? ''] && (
                      <Icon name={subSlugToIcon[part.sub_slug ?? '']} />
                    )}
                    <span>{subSlugToName?.[part.sub_slug ?? ''] ?? part.sub_slug ?? '—'}</span>
                  </span>
                </td>
              )}
              <td className={`${styles.td} ${styles.tdTier}`}>
                <span className={styles.price}>{formatPrice(part.best_price)}</span>
              </td>
              <td className={`${styles.td} ${styles.tdTier}`}>
                <span className={styles.price}>{formatPrice(part.best_price_10)}</span>
              </td>
              <td className={`${styles.td} ${styles.tdTier}`}>
                <span className={styles.price}>{formatPrice(part.best_price_100)}</span>
              </td>
              <td className={`${styles.td} ${styles.tdTier} ${styles.tdTierLast}`}>
                <span className={styles.price}>{formatPrice(part.best_price_1000)}</span>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
