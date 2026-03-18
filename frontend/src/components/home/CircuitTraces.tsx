import styles from './HeroSection.module.scss';

export default function CircuitTraces() {
  return (
    <svg
      className={styles.circuitTraces}
      viewBox="0 0 1200 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Horizontal traces */}
      <path
        d="M0 80 H300 L340 120 H600"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1.5"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '0s' }}
      />
      <path
        d="M200 200 H500 L540 160 H900"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1.5"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '0.3s' }}
      />
      <path
        d="M100 300 H400 L440 260 H700 L740 300 H1100"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1.5"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '0.6s' }}
      />

      {/* Vertical traces */}
      <path
        d="M400 0 V120 L440 160 V300"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1.5"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '0.9s' }}
      />
      <path
        d="M800 0 V80 L840 120 V250"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1.5"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '1.2s' }}
      />

      {/* Diagonal connectors */}
      <path
        d="M600 50 L650 100 H850 L900 150"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="1"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '1.5s' }}
      />
      <path
        d="M150 150 L200 200 H350 L400 250 H550"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="1"
        strokeDasharray="1000"
        strokeDashoffset="1000"
        className={styles.trace}
        style={{ animationDelay: '1.8s' }}
      />

      {/* Connection nodes (small circles at junctions) */}
      <circle cx="340" cy="120" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '0.5s' }} />
      <circle cx="540" cy="160" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '0.8s' }} />
      <circle cx="440" cy="260" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '1.1s' }} />
      <circle cx="740" cy="300" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '1.4s' }} />
      <circle cx="840" cy="120" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '1.7s' }} />
    </svg>
  );
}
