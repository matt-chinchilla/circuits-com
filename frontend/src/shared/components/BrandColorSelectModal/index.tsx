import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type BrandPalette, DEFAULT_PALETTE, extractBrandPalette } from '../../utils/brandPalette';
import { safeHexColor } from '../../utils/color';
import { nearestCssColor } from '../../utils/cssColorNames';
import { loadImage } from '../../utils/image';
import styles from './BrandColorSelectModal.module.scss';

export interface BrandColorSelectModalProps {
  source: HTMLCanvasElement | string; // cropped canvas (preferred) or data-URL/img src
  initialPrimary?: string | null;
  initialSecondary?: string | null;
  title?: string;
  onApply: (primary: string, secondary: string) => void; // both always #RRGGBB
  onSkip: () => void; // "keep existing / auto colors" — host decides semantics
}

/** Which row (by index into `palette.swatches`) or the bottom Custom row is checked for a role. */
type Selection = number | 'custom';

/** Grid placement — row/col are 1-based grid lines (row 1 = header). */
function gridPos(row: number, col: number): { gridRow: number; gridColumn: number } {
  return { gridRow: row, gridColumn: col };
}

export function BrandColorSelectModal({
  source,
  initialPrimary = null,
  initialSecondary = null,
  title = 'Choose brand colors',
  onApply,
  onSkip,
}: BrandColorSelectModalProps) {
  const [palette, setPalette] = useState<BrandPalette | null>(null);
  const [primarySel, setPrimarySel] = useState<Selection>(0);
  const [secondarySel, setSecondarySel] = useState<Selection>('custom');
  const [customPrimary, setCustomPrimary] = useState('');
  const [customSecondary, setCustomSecondary] = useState('');

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const firstPrimaryRadioRef = useRef<HTMLInputElement | null>(null);
  const preselectedRef = useRef(false);

  // Extract the palette on mount (cancel-flagged — string sources decode async).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const img = typeof source === 'string'
          ? await loadImage(source, source.startsWith('data:') ? undefined : 'anonymous')
          : source;
        const p = extractBrandPalette(img) ?? DEFAULT_PALETTE;
        if (!cancelled) setPalette(p);
      } catch {
        if (!cancelled) setPalette(DEFAULT_PALETTE);
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  // Preselection, once, the first time swatches are available.
  useEffect(() => {
    if (!palette || preselectedRef.current) return;
    preselectedRef.current = true;
    const { swatches } = palette;

    const matchIndex = (value: string | null | undefined): number | null => {
      const hex = safeHexColor(value);
      if (!hex) return null;
      const idx = swatches.findIndex((s) => s.hex.toLowerCase() === hex.toLowerCase());
      return idx >= 0 ? idx : null;
    };

    const primaryMatch = matchIndex(initialPrimary);
    if (primaryMatch != null) {
      setPrimarySel(primaryMatch);
    } else {
      const validPrimary = safeHexColor(initialPrimary);
      if (validPrimary) {
        setPrimarySel('custom');
        setCustomPrimary(validPrimary);
      } else {
        setPrimarySel(0);
      }
    }

    const secondaryMatch = matchIndex(initialSecondary);
    if (secondaryMatch != null) {
      setSecondarySel(secondaryMatch);
    } else {
      const validSecondary = safeHexColor(initialSecondary);
      setSecondarySel('custom');
      setCustomSecondary(validSecondary ?? palette.secondary);
    }
  }, [palette, initialPrimary, initialSecondary]);

  // Body scroll-lock with prior-value restore (mirrors LogoCropperModal).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Until swatches load there's nothing else focusable to hand off to — land
  // focus on Skip so it isn't stranded outside the portaled dialog. The first
  // Primary radio takes over once the palette effect below fires.
  useEffect(() => {
    skipRef.current?.focus();
  }, []);

  useEffect(() => {
    if (palette) firstPrimaryRadioRef.current?.focus();
  }, [palette]);

  // Esc = Skip; Tab = focus-trap. Capture-phase, added/removed identically to LogoCropperModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onSkip(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const nodes = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onSkip]);

  const swatches = palette?.swatches ?? [];

  const primaryValue = primarySel === 'custom'
    ? safeHexColor(customPrimary)
    : safeHexColor(swatches[primarySel]?.hex);
  const secondaryValue = secondarySel === 'custom'
    ? safeHexColor(customSecondary)
    : safeHexColor(swatches[secondarySel]?.hex);
  const canApply = primaryValue != null && secondaryValue != null;

  const customPrimaryInvalid = primarySel === 'custom' && customPrimary.length > 0 && primaryValue == null;
  const customSecondaryInvalid = secondarySel === 'custom' && customSecondary.length > 0 && secondaryValue == null;

  const handleApply = () => {
    if (primaryValue && secondaryValue) onApply(primaryValue, secondaryValue);
  };

  return createPortal(
    <div className={styles.scrim} onClick={onSkip} role="presentation">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title}>{title}</h2>

        {!palette ? (
          <p className={styles.loading}>Analyzing colors&hellip;</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <div className={styles.table}>
                <span className={styles.headerCell} style={gridPos(1, 1)} aria-hidden="true" />
                <span className={styles.headerCell} style={gridPos(1, 2)}>%</span>
                <span className={styles.headerCell} style={gridPos(1, 3)}>Hex</span>
                <span className={styles.headerCell} style={gridPos(1, 4)}>Name</span>
                <span className={styles.headerCell} style={gridPos(1, 5)}>Primary</span>
                <span className={styles.headerCell} style={gridPos(1, 6)}>Secondary</span>

                {swatches.map((s, i) => {
                  const row = i + 2;
                  const named = nearestCssColor(s.hex);
                  return (
                    <Fragment key={`${s.hex}-${i}`}>
                      <span
                        className={styles.chip}
                        style={{ ...gridPos(row, 1), backgroundColor: s.hex }}
                        aria-hidden="true"
                      />
                      <span className={styles.pct} style={gridPos(row, 2)}>{s.pct}%</span>
                      <span className={styles.hex} style={gridPos(row, 3)}>{s.hex}</span>
                      <span className={styles.name} style={gridPos(row, 4)}>
                        {named && !named.exact && <span aria-hidden="true">{'≈ '}</span>}
                        {named?.name ?? '—'}
                      </span>
                    </Fragment>
                  );
                })}

                {swatches.map((s, i) => (
                  <input
                    key={`p-${s.hex}-${i}`}
                    ref={i === 0 ? firstPrimaryRadioRef : undefined}
                    type="radio"
                    name="brand-color-primary"
                    className={styles.radio}
                    style={gridPos(i + 2, 5)}
                    checked={primarySel === i}
                    onChange={() => setPrimarySel(i)}
                    aria-label={`Use ${s.hex} as primary color`}
                  />
                ))}
                {swatches.map((s, i) => (
                  <input
                    key={`s-${s.hex}-${i}`}
                    type="radio"
                    name="brand-color-secondary"
                    className={styles.radio}
                    style={gridPos(i + 2, 6)}
                    checked={secondarySel === i}
                    onChange={() => setSecondarySel(i)}
                    aria-label={`Use ${s.hex} as secondary color`}
                  />
                ))}
              </div>
            </div>

            <div className={styles.customRow}>
              <span className={styles.customLabel}>Custom</span>
              <label className={styles.customField}>
                <span className={styles.customFieldLabel}>Primary</span>
                <input
                  type="text"
                  className={customPrimaryInvalid ? `${styles.hexInput} ${styles.hexInputInvalid}` : styles.hexInput}
                  placeholder="#RRGGBB"
                  value={customPrimary}
                  onChange={(e) => {
                    setCustomPrimary(e.target.value);
                    setPrimarySel('custom');
                  }}
                  aria-label="Custom primary hex color"
                />
              </label>
              <label className={styles.customField}>
                <span className={styles.customFieldLabel}>Secondary</span>
                <input
                  type="text"
                  className={customSecondaryInvalid ? `${styles.hexInput} ${styles.hexInputInvalid}` : styles.hexInput}
                  placeholder="#RRGGBB"
                  value={customSecondary}
                  onChange={(e) => {
                    setCustomSecondary(e.target.value);
                    setSecondarySel('custom');
                  }}
                  aria-label="Custom secondary hex color"
                />
              </label>
            </div>
          </>
        )}

        <div className={styles.actions}>
          <button ref={skipRef} type="button" className={styles.skip} onClick={onSkip}>Skip</button>
          <div
            className={styles.preview}
            style={canApply ? { background: `linear-gradient(135deg, ${primaryValue}, ${secondaryValue})` } : undefined}
            aria-hidden="true"
          />
          <button type="button" className={styles.apply} onClick={handleApply} disabled={!canApply}>
            Apply colors
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
