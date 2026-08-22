// Spec-sheet parts table — ported 1:1 from the design kit's SrPartsTable
// (Search.jsx + sponsor.css .sr-table*). Shared by the results PARTS section
// and the empty state's CLOSEST MATCHES & POPULAR PARTS block.
//
// 11 columns: Part (thumb + SKU + description) · Manufacturer · Package ·
// Mount · RoHS · Lead · MOQ · Dist. · Best Price · Stock · Status. Every
// nullable spec field renders the em dash, never a blank cell.
import { useNavigate } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import type { SearchPart } from '@public/types/search';
import { formatCount, formatLeadTime, formatPrice, formatRohs } from '../lib/srFormat';
import styles from './SrPartsTable.module.scss';

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'obsolete') return `${styles.status} ${styles.statusBad}`;
  if (s !== 'active') return `${styles.status} ${styles.statusWarn}`;
  return styles.status;
}

export default function SrPartsTable({ rows }: { rows: SearchPart[] }) {
  const navigate = useNavigate();

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Part</th>
            <th>Manufacturer</th>
            <th>Package</th>
            <th>Mount</th>
            <th>RoHS</th>
            <th>Lead</th>
            <th>MOQ</th>
            <th>Dist.</th>
            <th className={styles.num}>Best Price</th>
            <th className={styles.num}>Stock</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr
              key={p.id}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) return;
                navigate(`/part/${p.slug}`);
              }}
            >
              <td>
                <span className={styles.tdPart}>
                  <span className={styles.thumb} aria-hidden="true">
                    <Icon name={p.category_icon ?? 'lightning'} />
                  </span>
                  <span className={styles.tdId}>
                    <span className={styles.sku}>{p.sku}</span>
                    {p.description != null && p.description !== '' && (
                      <span className={styles.tdTitle}>{p.description}</span>
                    )}
                  </span>
                </span>
              </td>
              <td>{p.manufacturer_name ?? '\u2014'}</td>
              <td className={styles.mono}>{p.package ?? '\u2014'}</td>
              <td className={styles.mono}>{p.mount ?? '\u2014'}</td>
              <td>{formatRohs(p.rohs)}</td>
              <td className={styles.mono}>{formatLeadTime(p.lead_time_days)}</td>
              <td className={styles.mono}>{p.moq != null ? formatCount(p.moq) : '\u2014'}</td>
              <td className={styles.mono}>{p.dist_count}</td>
              <td className={`${styles.mono} ${styles.num}`}>{formatPrice(p.best_price)}</td>
              <td className={`${styles.mono} ${styles.num}`}>{formatCount(p.stock)}</td>
              <td>
                {p.lifecycle_status != null && p.lifecycle_status !== '' ? (
                  <span className={statusClass(p.lifecycle_status)}>{p.lifecycle_status}</span>
                ) : (
                  '\u2014'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
