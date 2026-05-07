import styles from './InboxZeroEmptyState.module.scss';

// "All caught up" empty state — an envelope with a single electron tracing
// along an unfurling circuit-line into a green checkmark. Echoes the public
// site's CircuitTraces vocabulary in admin without dragging the SVG into the
// admin scope. Animates once on mount.
export default function InboxZeroEmptyState() {
  return (
    <div className={styles.inboxZero}>
      <svg viewBox="0 0 280 200" width="280" height="200" aria-hidden="true">
        <defs>
          <pattern id="iz-grid" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M12 0H0v12" fill="none" stroke="#e5e7eb" strokeWidth=".5" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="280" height="200" fill="url(#iz-grid)" />
        {/* envelope */}
        <g transform="translate(70 50)">
          <rect
            x="0"
            y="20"
            width="140"
            height="80"
            rx="4"
            fill="#fff"
            stroke="#0a4a2e"
            strokeWidth="1.6"
          />
          <path
            d="M0 20 L70 70 L140 20"
            fill="none"
            stroke="#0a4a2e"
            strokeWidth="1.6"
          />
          <path
            d="M0 100 L55 60 M140 100 L85 60"
            fill="none"
            stroke="#0a4a2e"
            strokeWidth="1.6"
          />
        </g>
        {/* trace from envelope to checkmark */}
        <path
          d="M210 90 L235 90 L235 130 L255 130"
          fill="none"
          stroke="#44bd13"
          strokeWidth="2"
          strokeDasharray="80"
          strokeDashoffset="0"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="80"
            to="0"
            dur="1.4s"
            begin="0.2s"
            fill="freeze"
          />
        </path>
        <circle cx="210" cy="90" r="3" fill="#44bd13" />
        <circle cx="235" cy="130" r="3" fill="#44bd13" />
        {/* electron travelling the trace */}
        <circle r="3" fill="#44bd13">
          <animateMotion
            dur="1.4s"
            begin="0.2s"
            repeatCount="1"
            fill="freeze"
            path="M210 90 L235 90 L235 130 L255 130"
          />
        </circle>
        {/* checkmark */}
        <g transform="translate(245 120)" opacity="0">
          <animate
            attributeName="opacity"
            from="0"
            to="1"
            begin="1.4s"
            dur=".3s"
            fill="freeze"
          />
          <circle cx="10" cy="10" r="11" fill="#44bd13" />
          <path
            d="M5 10 L9 14 L15 7"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
      <div className={styles.headline}>INBOX_ZERO</div>
      <p className={styles.sub}>All messages handled. Nothing more to triage.</p>
    </div>
  );
}
