import { useState, useCallback } from 'react';
import styles from './DataTable.module.scss';

interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  mono?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyMessage?: string;
}

export default function DataTable<T extends { id: string | number } & Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  loading,
  emptyMessage = 'No data found.',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey]
  );

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        const cmp =
          typeof aVal === 'number' && typeof bVal === 'number'
            ? aVal - bVal
            : String(aVal).localeCompare(String(bVal));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : data;

  if (loading) {
    return (
      <div className={styles.loading}>Loading...</div>
    );
  }

  if (data.length === 0) {
    return (
      <div className={styles.empty}>{emptyMessage}</div>
    );
  }

  const sortAriaFor = (key: string): 'ascending' | 'descending' | 'none' => {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  };

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`${styles.th} ${col.sortable ? styles.sortable : ''}`}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
                tabIndex={col.sortable ? 0 : undefined}
                onKeyDown={
                  col.sortable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSort(col.key);
                        }
                      }
                    : undefined
                }
                role={col.sortable ? 'columnheader' : undefined}
                aria-sort={col.sortable ? sortAriaFor(col.key) : undefined}
              >
                {col.label}
                {col.sortable && sortKey === col.key && (
                  <span className={styles.sortIcon}>
                    {sortDir === 'asc' ? ' \u25B2' : ' \u25BC'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className={`${styles.row} ${onRowClick ? styles.clickableRow : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className={col.mono ? styles.tdMono : styles.td}>
                  {col.render
                    ? col.render(row)
                    : (row[col.key] as React.ReactNode) ?? '\u2014'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
