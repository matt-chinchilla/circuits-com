import { useEffect, useState } from 'react';
import { DEFAULT_PALETTE, extractBrandPalette } from '../utils/brandPalette';
import { safeHexColor } from '../utils/color';
import { loadImage } from '../utils/image';
import styles from './BrandColorPicker.module.scss';

export interface BrandColorPickerProps {
  logoSrc: string | null;
  primary: string | null;
  secondary: string | null;
  onChange: (role: 'primary' | 'secondary', hex: string) => void;
  allowCustom?: boolean;
  compact?: boolean;
  className?: string;
}

const DEFAULT_SWATCHES = ['#1d3a8f', '#0a4a2e', '#a88d2e', '#7a1f2b', '#2b6777', '#464d55'];

export function BrandColorPicker({
  logoSrc, primary, secondary, onChange, allowCustom = false, compact = false, className,
}: BrandColorPickerProps) {
  const [swatches, setSwatches] = useState<string[]>(DEFAULT_SWATCHES);

  useEffect(() => {
    let cancelled = false;
    if (!logoSrc) {
      setSwatches(DEFAULT_SWATCHES);
      return undefined;
    }
    (async () => {
      try {
        const img = await loadImage(logoSrc, logoSrc.startsWith('data:') ? undefined : 'anonymous');
        const palette = extractBrandPalette(img) ?? DEFAULT_PALETTE;
        if (!cancelled) setSwatches(palette.swatches.length >= 2 ? palette.swatches : DEFAULT_SWATCHES);
      } catch {
        if (!cancelled) setSwatches(DEFAULT_SWATCHES);
      }
    })();
    return () => { cancelled = true; };
  }, [logoSrc]);

  const row = (role: 'primary' | 'secondary', current: string | null) => (
    <div className={styles.row}>
      <span className={styles.roleLabel}>{role === 'primary' ? 'Primary' : 'Secondary'}</span>
      <div className={styles.chips} role="radiogroup" aria-label={`${role} brand color`}>
        {swatches.map((hex) => (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={current != null && current.toLowerCase() === hex.toLowerCase()}
            aria-label={hex}
            className={current != null && current.toLowerCase() === hex.toLowerCase()
              ? `${styles.chip} ${styles.chipActive}`
              : styles.chip}
            style={{ backgroundColor: hex }}
            onClick={() => onChange(role, hex)}
          />
        ))}
        {allowCustom && (
          <input
            type="text"
            className={styles.hexInput}
            placeholder="#RRGGBB"
            value={current ?? ''}
            onChange={(e) => onChange(role, e.target.value)}
            aria-label={`Custom ${role} hex color`}
          />
        )}
      </div>
    </div>
  );

  const validPair = safeHexColor(primary) != null && safeHexColor(secondary) != null;

  return (
    <div className={compact ? `${styles.picker} ${styles.compact}${className ? ` ${className}` : ''}` : `${styles.picker}${className ? ` ${className}` : ''}`}>
      {row('primary', primary)}
      {row('secondary', secondary)}
      {validPair && (
        <div className={styles.preview} aria-hidden="true">
          <span
            className={styles.previewChip}
            style={{ background: `linear-gradient(135deg, ${safeHexColor(primary)}, ${safeHexColor(secondary)})` }}
          />
          <span className={styles.previewLabel}>Board tint</span>
        </div>
      )}
    </div>
  );
}
