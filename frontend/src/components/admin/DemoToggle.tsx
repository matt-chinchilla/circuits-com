import { useDemo } from '../../contexts/DemoContext';
import styles from './DemoToggle.module.scss';

export default function DemoToggle() {
  const { demoMode, toggleDemo } = useDemo();

  return (
    <button
      className={`${styles.toggle} ${demoMode ? styles.on : styles.off}`}
      onClick={toggleDemo}
      title={demoMode ? 'Disable demo data' : 'Enable demo data'}
    >
      <span className={styles.indicator} />
      <span className={styles.label}>
        Demo Data: {demoMode ? 'ON' : 'OFF'}
      </span>
    </button>
  );
}
