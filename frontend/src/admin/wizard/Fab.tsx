import styles from './Wizard.module.scss';
import { WI } from './icons';

interface FabProps {
  menuOpen: boolean;
  onClick: () => void;
  pulse: boolean;
  progress: number; // 0–1
}

// Apple-style floating action button. When a flow is active, the
// progress ring fills clockwise. The attention-pulse only animates on
// first session (before the user has clicked once).
export default function Fab({ menuOpen, onClick, pulse, progress }: FabProps) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);
  const fabClass = `${styles.fab} ${pulse ? styles.fabPulse : ''}`;

  return (
    <button
      type="button"
      className={fabClass}
      onClick={onClick}
      aria-label={menuOpen ? 'Close help menu' : 'Open help menu'}
      aria-expanded={menuOpen}
    >
      <span className={styles.fabGlow} />
      <span className={styles.fabIcon}>{menuOpen ? <WI.X /> : <WI.Question />}</span>
      {progress > 0 && progress < 1 && (
        <svg className={styles.fabProgress} viewBox="0 0 64 64" aria-hidden="true">
          <circle className={styles.fabProgressTrack} cx="32" cy="32" r={radius} />
          <circle
            className={styles.fabProgressFill}
            cx="32"
            cy="32"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 32 32)"
          />
        </svg>
      )}
    </button>
  );
}
