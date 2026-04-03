import styles from './StatCard.module.scss';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: string;
  trend?: { value: number; label: string };
  onClick?: () => void;
}

export default function StatCard({ label, value, icon, trend, onClick }: StatCardProps) {
  return (
    <div
      className={`${styles.card} ${onClick ? styles.clickable : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
    >
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.icon}>{icon}</span>
      </div>
      <div className={styles.value}>{value}</div>
      {trend && (
        <div
          className={`${styles.trend} ${trend.value >= 0 ? styles.trendUp : styles.trendDown}`}
        >
          <span className={styles.trendValue}>
            {trend.value >= 0 ? '+' : ''}
            {trend.value}%
          </span>
          <span className={styles.trendLabel}>{trend.label}</span>
        </div>
      )}
    </div>
  );
}
