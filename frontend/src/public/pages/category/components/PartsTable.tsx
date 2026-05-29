import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { PublicPart } from '@public/types/part';
import Icon from '@shared/components/Icon';
import ColumnHeader from './ColumnHeader';
import type { SortState } from './ColumnHeader';
import styles from './PartsTable.module.scss';

interface PartsTableProps {
  parts: PublicPart[];
  sort: SortState;
  setSort: (s: SortState) => void;
  skuSearch: string;
  setSkuSearch: (v: string) => void;
  mfgValues: string[];
  mfgSelected: Set<string>;
  setMfgSelected: (v: Set<string>) => void;
  subValues?: string[];
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

function formatPrice(price: number | null | undefined): string {
  if (price == null) return '—';
  if (price >= 100) return `$${price.toFixed(0)}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(3)}`;
}

export default function PartsTable({
  parts, sort, setSort,
  skuSearch, setSkuSearch,
  mfgValues, mfgSelected, setMfgSelected,
  subValues, subSelected, setSubSelected,
  subSlugToName, subSlugToIcon,
}: PartsTableProps) {
  if (parts.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No parts match the current filters.</p>
      </div>
    );
  }

  const showSubColumn = subValues && subValues.length > 0;

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
              filterValues={mfgValues}
              filterSelected={mfgSelected}
              setFilterSelected={setMfgSelected}
            />
            {showSubColumn && subSelected && setSubSelected && (
              <ColumnHeader
                label="Category" sortKey="sub" hideClass={styles.hideMobile}
                sort={sort} setSort={setSort}
                filterValues={subValues}
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
