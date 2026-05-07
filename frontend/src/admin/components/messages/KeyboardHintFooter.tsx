import styles from './KeyboardHintFooter.module.scss';

interface Props {
  visible: boolean;
}

// Thin footer pinned to the bottom of the inbox-list page revealing the
// keyboard shortcuts (j/k/e/r/...) once the user has interacted via keyboard.
// Hidden by default so first load doesn't feel preachy.
export default function KeyboardHintFooter({ visible }: Props) {
  return (
    <div className={`${styles.kbdHint} ${visible ? styles.visible : ''}`}>
      <span>
        <kbd>j</kbd>/<kbd>k</kbd> navigate
      </span>
      <span>
        <kbd>e</kbd> archive
      </span>
      <span>
        <kbd>r</kbd> reply
      </span>
      <span>
        <kbd>/</kbd> search
      </span>
    </div>
  );
}
