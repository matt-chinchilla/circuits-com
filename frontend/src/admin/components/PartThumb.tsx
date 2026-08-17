// Part-photo thumbnail with a glyph fallback — the ONE implementation for
// every feed-image render site (SyncConsole rows, dashboard Recent Activity).
//
// Two rules it owns so call sites cannot diverge:
//   1. The URL goes through `safeImageUrl` HERE — a stored `javascript:` /
//      `data:text/html` value must never reach an `src`, whichever panel
//      renders it.
//   2. The broken-image swap is React state, not a mutation of the <img>
//      element: an `onError` handler that rewrites `src`/`style` in place
//      fights the next render and leaves the DOM disagreeing with the
//      component.

import { useMemo, useState } from 'react';
import Icon from '@shared/components/Icon';
import { safeImageUrl } from '@shared/utils/url';
import styles from './PartThumb.module.scss';

interface Props {
  src?: string | null;
  /** Site-specific layout (flex/margins) — composed onto whichever element
   * renders. Sizing and fit stay here so the thumbs match across panels. */
  className?: string;
}

export default function PartThumb({ src, className }: Props) {
  const [broken, setBroken] = useState(false);
  // Parsed once per URL, not once per render — the console re-renders on
  // every stream event and the value never changes after arrival.
  const safe = useMemo(() => safeImageUrl(src), [src]);
  const extra = className ? ` ${className}` : '';
  if (!safe || broken) {
    return (
      <span className={`${styles.fallback}${extra}`} aria-hidden="true">
        <Icon name="package" />
      </span>
    );
  }
  return (
    <img
      className={`${styles.thumb}${extra}`}
      src={safe}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}
