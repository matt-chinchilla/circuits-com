import styles from './Wizard.module.scss';
import { WI } from './icons';

// Pointer-arrow bubble shown to the right of the FAB on first session.
// Click anywhere on the body OR the close button dismisses + writes
// wiz-welcomed=1 to localStorage so it doesn't return.
export default function WelcomeBubble({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className={styles.welcome}
      onClick={onDismiss}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className={styles.welcomeBody}>
        <div className={styles.welcomeTitle}>Need a walkthrough?</div>
        <div className={styles.welcomeSub}>
          Tap the help button anytime — there&apos;s a guided tour for every admin task.
        </div>
      </div>
      <button
        type="button"
        className={styles.welcomeClose}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
      >
        <WI.X />
      </button>
    </div>
  );
}
