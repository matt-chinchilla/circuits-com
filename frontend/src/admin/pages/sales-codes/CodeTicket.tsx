import type { ReactNode } from 'react';
import styles from './SalesCodes.module.scss';

// A sales code drawn as a ticket stub: points off on the stub, the code on
// the body. `large` is the one-time reveal after creating a code; `dim` is a
// code that can no longer be used (expired / used up / switched off).

interface Props {
  display: string;
  points: number;
  large?: boolean;
  dim?: boolean;
  /** A line under the code on the large ticket. */
  caption?: ReactNode;
}

export default function CodeTicket({ display, points, large = false, dim = false, caption }: Props) {
  return (
    <span
      className={`${styles.ticket} ${large ? styles.ticketLarge : ''}`}
      data-dim={dim ? 'true' : undefined}
    >
      <span className={styles.ticketStub}>
        {large ? (
          <>
            {`−${points}`}
            <small>points</small>
          </>
        ) : (
          `−${points}`
        )}
      </span>
      <span className={styles.ticketCode}>
        {display}
        {large && caption && <small>{caption}</small>}
      </span>
    </span>
  );
}
