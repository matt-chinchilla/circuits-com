import type { ReactNode } from 'react';
import styles from './DatasheetFrame.module.scss';

interface Props {
  children: ReactNode;
  className?: string;
}

// Datasheet card shell — subtle PCB grid background + 4 corner brackets.
// Direct echo of the public Contact-page founder cards. Pure presentation;
// children are responsible for their own padding/layout.
export default function DatasheetFrame({ children, className }: Props) {
  return (
    <div className={`${styles.datasheetCard} ${className ?? ''}`}>
      <span className={`${styles.dsCorner} ${styles.tl}`} />
      <span className={`${styles.dsCorner} ${styles.tr}`} />
      <span className={`${styles.dsCorner} ${styles.bl}`} />
      <span className={`${styles.dsCorner} ${styles.br}`} />
      {children}
    </div>
  );
}
