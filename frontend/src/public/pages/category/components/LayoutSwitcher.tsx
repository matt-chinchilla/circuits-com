import styles from './LayoutSwitcher.module.scss';

type LayoutMode = 'grid' | 'list' | 'compact' | 'cards';

interface LayoutSwitcherProps {
  active: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}

const OPTIONS: { mode: LayoutMode; icon: string; label: string }[] = [
  { mode: 'grid', icon: '\u229E', label: 'Grid view' },
  { mode: 'list', icon: '\u2630', label: 'List view' },
  { mode: 'compact', icon: '\u2B1A', label: 'Compact view' },
  { mode: 'cards', icon: '\u25A6', label: 'Cards view' },
];

export default function LayoutSwitcher({ active, onChange }: LayoutSwitcherProps) {
  return (
    <div className={styles.switcher} role="radiogroup" aria-label="Layout options">
      {OPTIONS.map(({ mode, icon, label }) => (
        <button
          key={mode}
          className={`${styles.btn} ${active === mode ? styles.active : ''}`}
          onClick={() => onChange(mode)}
          role="radio"
          aria-checked={active === mode}
          aria-label={label}
          title={label}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
