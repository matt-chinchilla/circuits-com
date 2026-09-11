import { useState } from 'react';
import Icon from '@shared/components/Icon';
import { safeImageUrl } from '@shared/utils/url';
import styles from './PartThumb.module.scss';

/**
 * The 36px part thumbnail beside a SKU in the catalog tables (category page,
 * search results) — the same two tiers the BOM tool's rows use: the stored
 * product photo, else a glyph tile. The tile carries the category's own icon
 * so an un-photographed part still reads as "a resistor" rather than as a
 * missing image.
 *
 * `safeImageUrl`, never a raw src: `image_url` is stored content a feed or an
 * admin supplied, so it carries the same `javascript:`/`data:text/html` risk
 * as a sponsor logo. `alt` is empty on purpose — the SKU sits right beside
 * it, and a page of "<part> product photo" is screen-reader noise.
 */
export default function PartThumb({
  src,
  icon,
}: {
  src: string | null | undefined;
  /** Phosphor name for the fallback tile; the category's icon when known. */
  icon?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const safe = safeImageUrl(src);

  if (safe == null || failed) {
    return (
      <span className={styles.fallback} aria-hidden="true">
        <Icon name={icon || 'cpu'} />
      </span>
    );
  }

  return (
    <img
      className={styles.img}
      src={safe}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
