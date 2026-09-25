// CausticField — the slow light field behind the About page's "Why" section.
// SEAM STUB: the shader implementer replaces this file wholesale (spec
// docs/superpowers/specs/2026-09-25-about-page-design.md, "<CausticField />").
// Until then it renders the static fallback so the page compiles.
import type { ReactElement } from 'react';
import styles from './CausticField.module.scss';

export interface CausticFieldProps {
  className?: string;
  getContext?: (canvas: HTMLCanvasElement) => WebGLRenderingContext | null;
}

export default function CausticField({ className }: CausticFieldProps): ReactElement {
  const cls = className ? `${styles.field} ${className}` : styles.field;
  return <div className={cls} aria-hidden="true" data-caustic="static" />;
}
