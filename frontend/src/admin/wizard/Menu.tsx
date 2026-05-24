import { useEffect, useRef } from 'react';
import styles from './Wizard.module.scss';
import { WI } from './icons';
import { FLOWS } from './flows';
import type { Flow } from './types';

interface MenuProps {
  onPick: (flowId: string, resume: boolean) => void;
  onClose: () => void;
  activeFlow: Flow | null;
  stepIndex: number;
}

const ACCENT_CLASS: Record<Flow['accent'], string | undefined> = {
  primary: undefined,
  blue: styles.tourCardAccentBlue,
  gold: styles.tourCardAccentGold,
  violet: styles.tourCardAccentViolet,
  rose: styles.tourCardAccentRose,
  cyan: styles.tourCardAccentCyan,
  amber: styles.tourCardAccentAmber,
};

// Tours catalog panel. Esc-to-close + focus-trap on first tab/shift-tab.
export default function Menu({ onPick, onClose, activeFlow, stepIndex }: MenuProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  return (
    <div
      ref={dialogRef}
      className={styles.menu}
      role="dialog"
      aria-modal="false"
      aria-labelledby="wiz-menu-title"
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.menuHead}>
        <button
          type="button"
          className={styles.menuClose}
          onClick={onClose}
          aria-label="Close menu"
        >
          <WI.X />
        </button>
        <div className={styles.menuEyebrow}>Guided Tours</div>
        <h2 id="wiz-menu-title" className={styles.menuTitle}>
          How can I help?
        </h2>
        <p className={styles.menuSub}>
          Walk through any admin task step-by-step. Each tour ends by cleaning up the demo data so
          you don&apos;t pollute your catalog.
        </p>
      </div>
      {activeFlow && (
        <button
          type="button"
          className={styles.resume}
          onClick={() => onPick(activeFlow.id, true)}
        >
          <span className={styles.resumeIcon}>
            <i className={`ph-light ph-${activeFlow.icon}`} aria-hidden="true" />
          </span>
          <span className={styles.resumeText}>
            <span className={styles.resumeTitle}>Resume — {activeFlow.title}</span>
            <span className={styles.resumeStep}>
              Step {stepIndex + 1} of {activeFlow.steps.length}
            </span>
          </span>
          <WI.ChevRight />
        </button>
      )}
      <div className={styles.menuList}>
        {FLOWS.map((f) => {
          const accentClass = ACCENT_CLASS[f.accent];
          const cls = accentClass ? `${styles.tourCard} ${accentClass}` : styles.tourCard;
          return (
            <button key={f.id} type="button" className={cls} onClick={() => onPick(f.id, false)}>
              <span className={styles.tourIcon}>
                <i className={`ph-light ph-${f.icon}`} aria-hidden="true" />
              </span>
              <span className={styles.tourBody}>
                <span className={styles.tourTitle}>{f.title}</span>
                <span className={styles.tourSummary}>{f.summary}</span>
              </span>
              <span className={styles.tourChev}>
                <WI.ChevRight />
              </span>
            </button>
          );
        })}
      </div>
      <div className={styles.menuFoot}>
        <span>
          <span className={styles.dot}>●</span> {FLOWS.length} tours · local-only, no data sent
        </span>
        <span>v1.0</span>
      </div>
    </div>
  );
}
