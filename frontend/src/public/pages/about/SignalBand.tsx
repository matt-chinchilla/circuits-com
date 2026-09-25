// SignalBand — the logic-analyzer band between the About page's manifesto and
// its commitments rail. SEAM STUB: the band implementer replaces this file
// wholesale (spec docs/superpowers/specs/2026-09-25-about-page-design.md,
// "Revision 2"). Until then it renders an empty band so the page compiles.
import type { ReactElement } from 'react';
import styles from './SignalBand.module.scss';

export interface SignalBandProps {
  className?: string;
}

export default function SignalBand({ className }: SignalBandProps): ReactElement {
  const cls = className ? `${styles.band} ${className}` : styles.band;
  return <div className={cls} aria-hidden="true" data-signal="still" />;
}
