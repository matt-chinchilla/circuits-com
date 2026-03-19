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
      {/* === Horizontal traces === */}
      <path d="M0 80 H300 L340 120 H600" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '0s' }} />
      <path d="M200 200 H500 L540 160 H900" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '0.4s' }} />
      <path d="M100 300 H400 L440 260 H700 L740 300 H1100" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '0.8s' }} />
      <path d="M0 160 H150 L180 130 H350" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '1.2s' }} />
      <path d="M850 240 H1000 L1030 210 H1200" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '1.6s' }} />
      <path d="M50 360 H250 L280 330 H480" stroke="rgba(255,255,255,0.07)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '2.0s' }} />
      <path d="M600 360 H800 L830 330 H1050" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '2.4s' }} />

      {/* === Vertical traces === */}
      <path d="M400 0 V120 L440 160 V300" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '0.6s' }} />
      <path d="M800 0 V80 L840 120 V250" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '1.0s' }} />
      <path d="M200 0 V60 L220 80 V180" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '1.4s' }} />
      <path d="M1050 100 V200 L1070 220 V350" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '1.8s' }} />
      <path d="M600 0 V50 L620 70 V130" stroke="rgba(255,255,255,0.07)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '2.2s' }} />

      {/* === Diagonal connectors === */}
      <path d="M600 50 L650 100 H850 L900 150" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '2.6s' }} />
      <path d="M150 150 L200 200 H350 L400 250 H550" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '3.0s' }} />
      <path d="M950 60 L1000 110 H1100 L1150 160" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '3.4s' }} />
      <path d="M300 280 L340 320 H500 L540 360" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="1000" strokeDashoffset="1000" className={styles.trace} style={{ animationDelay: '3.8s' }} />

      {/* === IC chip outlines (DIP package rectangles with pin lines) === */}
      {/* IC 1 - near top-left */}
      <rect x="120" y="60" width="50" height="30" rx="2" stroke="rgba(255,255,255,0.1)" strokeWidth="1" fill="none" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="125" y1="60" x2="125" y2="55" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="135" y1="60" x2="135" y2="55" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="145" y1="60" x2="145" y2="55" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="155" y1="60" x2="155" y2="55" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="125" y1="90" x2="125" y2="95" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="135" y1="90" x2="135" y2="95" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="145" y1="90" x2="145" y2="95" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />
      <line x1="155" y1="90" x2="155" y2="95" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '0.3s' }} />

      {/* IC 2 - center-right area */}
      <rect x="880" y="140" width="60" height="35" rx="2" stroke="rgba(255,255,255,0.1)" strokeWidth="1" fill="none" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="888" y1="140" x2="888" y2="135" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="900" y1="140" x2="900" y2="135" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="912" y1="140" x2="912" y2="135" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="924" y1="140" x2="924" y2="135" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="888" y1="175" x2="888" y2="180" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="900" y1="175" x2="900" y2="180" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="912" y1="175" x2="912" y2="180" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />
      <line x1="924" y1="175" x2="924" y2="180" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" className={styles.trace} style={{ animationDelay: '1.5s' }} />

      {/* === Capacitor symbols (two parallel lines with gap) === */}
      <line x1="480" y1="110" x2="480" y2="130" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '0.7s' }} />
      <line x1="486" y1="110" x2="486" y2="130" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '0.7s' }} />

      <line x1="720" y1="190" x2="720" y2="210" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '1.9s' }} />
      <line x1="726" y1="190" x2="726" y2="210" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '1.9s' }} />

      <line x1="350" y1="310" x2="350" y2="330" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '2.8s' }} />
      <line x1="356" y1="310" x2="356" y2="330" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" className={styles.trace} style={{ animationDelay: '2.8s' }} />

      {/* === Resistor zigzags (polyline paths) === */}
      <path d="M560 80 L565 70 L575 90 L585 70 L595 90 L600 80" stroke="rgba(255,255,255,0.1)" strokeWidth="1" fill="none" strokeLinejoin="round" className={styles.trace} style={{ animationDelay: '1.1s' }} />
      <path d="M700 270 L705 260 L715 280 L725 260 L735 280 L740 270" stroke="rgba(255,255,255,0.1)" strokeWidth="1" fill="none" strokeLinejoin="round" className={styles.trace} style={{ animationDelay: '2.3s' }} />
      <path d="M250 230 L255 220 L265 240 L275 220 L285 240 L290 230" stroke="rgba(255,255,255,0.08)" strokeWidth="1" fill="none" strokeLinejoin="round" className={styles.trace} style={{ animationDelay: '3.2s' }} />

      {/* === Switch symbols (two lines with gap + arc) === */}
      <path d="M660 120 H670 M670 120 L690 110 M690 120 H700" stroke="rgba(255,255,255,0.09)" strokeWidth="1" fill="none" className={styles.trace} style={{ animationDelay: '1.3s' }} />
      <path d="M430 340 H440 M440 340 L460 330 M460 340 H470" stroke="rgba(255,255,255,0.08)" strokeWidth="1" fill="none" className={styles.trace} style={{ animationDelay: '3.6s' }} />

      {/* === Connection nodes (circles at junctions) === */}
      <circle cx="340" cy="120" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '0s' }} />
      <circle cx="540" cy="160" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '0.5s' }} />
      <circle cx="440" cy="260" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '1.0s' }} />
      <circle cx="740" cy="300" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '1.5s' }} />
      <circle cx="840" cy="120" r="3" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '2.0s' }} />
      <circle cx="180" cy="130" r="2.5" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '2.5s' }} />
      <circle cx="600" cy="80" r="2.5" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '3.0s' }} />
      <circle cx="1030" cy="210" r="2.5" fill="rgba(255,255,255,0.12)" className={styles.node} style={{ animationDelay: '3.5s' }} />

      {/* === Via holes (small filled circles at intersections) === */}
      <circle cx="400" cy="120" r="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '0.8s' }} />
      <circle cx="800" cy="80" r="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '1.3s' }} />
      <circle cx="440" cy="160" r="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '1.8s' }} />
      <circle cx="700" cy="300" r="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '2.3s' }} />
      <circle cx="1000" cy="110" r="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '2.8s' }} />
      <circle cx="220" cy="80" r="3.5" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '3.3s' }} />
      <circle cx="550" cy="360" r="3.5" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" className={styles.node} style={{ animationDelay: '3.8s' }} />
    </svg>
  );
}
