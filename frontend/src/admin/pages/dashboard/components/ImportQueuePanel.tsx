// ImportQueuePanel — CSV batches waiting on review.
//
// There is no queue endpoint yet, so live mode shows an honest empty state and
// demo mode shows the four batches from the v5 design bundle.

import { Link } from 'react-router-dom';
import styles from '../DashboardPage.module.scss';

interface QueueRow {
  filename: string;
  size: string;
  rows: number;
  status: 'pending' | 'approved';
}

const DEMO_QUEUE: QueueRow[] = [
  { filename: 'digikey-q4-pricing.csv', size: '4.2 MB', rows: 18432, status: 'pending' },
  { filename: 'mouser-analog-ics.csv', size: '2.1 MB', rows: 9201, status: 'approved' },
  { filename: 'arrow-mcus-restock.csv', size: '892 KB', rows: 2412, status: 'pending' },
  { filename: 'newark-passives-week48.csv', size: '1.4 MB', rows: 5128, status: 'approved' },
];

const STATUS_CLASS: Record<QueueRow['status'], string> = {
  pending: styles.pending,
  approved: styles.approved,
};

export default function ImportQueuePanel({ demoMode }: { demoMode: boolean }) {
  const rows = demoMode ? DEMO_QUEUE : [];

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Import Queue</h3>
        <Link to="/admin/import" className={styles.panelLink}>
          Review all &rarr;
        </Link>
      </div>
      <div className={styles.queue}>
        {rows.length === 0 ? (
          <div className={styles.empty}>No imports pending review.</div>
        ) : (
          rows.map((q) => (
            <div key={q.filename} className={styles.queueRow}>
              <div>
                <div className={styles.queueName}>{q.filename}</div>
                <div className={styles.queueMeta}>
                  {q.size} &middot; {q.rows.toLocaleString()} rows
                </div>
              </div>
              <span className={`${styles.queuePill} ${STATUS_CLASS[q.status]}`}>{q.status}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
