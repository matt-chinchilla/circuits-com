// The call-outcome popover — the admin console's first PORTALED popover.
//
// Portaled to document.body (createPortal) because its anchor is a 28px disc
// inside a <td>: any ancestor with overflow, a transform or a stacking context
// would clip it, and the leads table has all three at various widths. Fixed
// positioning + a viewport clamp + flip-above is the same contract the public
// category ColumnHeader popover already ships.
//
// Dismissal follows the house guards exactly: outside-click, Esc, scroll and
// resize, each testing `e.target instanceof Node` BEFORE calling .contains()
// (Node.contains(window) THROWS — see CLAUDE.md). Scroll/resize close rather
// than reposition, which is the established behaviour for every popover here;
// the cost is that a scroll mid-note discards the note, and that trade is
// deliberate: a popover that floats away from its anchor is worse.
//
// The anchor is passed as an ELEMENT, not a rect. The document mousedown
// listener fires before the anchor's own onClick, so without the element the
// menu would close and the anchor would immediately re-open it — the classic
// toggle race. Holding the element lets the guard exclude its subtree.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { AdminLeadDetail, LeadOutcome } from '@admin/types/leads';
import { OUTCOME_META, OUTCOME_ORDER, outcomeInkVars } from './outcome';
import styles from './OutcomeMenu.module.scss';

// Tier here is a LABEL on the call record, never a sponsor row (owner decision
// L7 — outcomes never create sponsorships). Lowercase values because that is
// what the column stores; the sponsors desk normalizes casing on its own side.
const SALE_TIERS: Array<{ value: string; label: string }> = [
  { value: 'platinum', label: 'Platinum' },
  { value: 'gold', label: 'Gold' },
  { value: 'silver', label: 'Silver' },
];

// Server caps (ContactCreate): note 500 chars, sale_tier 10.
const NOTE_MAX = 500;

const MENU_WIDTH = 272;
const GAP = 6;
const EDGE = 8;

interface OutcomeMenuProps {
  leadId: string;
  /** The element the menu hangs off — also the outside-click exclusion zone. */
  anchor: HTMLElement;
  /** Who/what this call was with, shown as the popover's caption. */
  label: string;
  /** The lead as the server re-serialized it after the write. */
  onRecorded: (detail: AdminLeadDetail) => void;
  onClose: () => void;
}

export default function OutcomeMenu({
  leadId,
  anchor,
  label,
  onRecorded,
  onClose,
}: OutcomeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [selected, setSelected] = useState<LeadOutcome | null>(null);
  const [saleTier, setSaleTier] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // `null` until measured: rendering at 0,0 for one frame would flash the
  // panel in the top-left corner before the layout effect lands.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position AFTER paint-layout but BEFORE the browser paints, and re-run when
  // `selected` changes — choosing Converted grows the panel by a select and a
  // note field, which can invalidate a flip-above decision.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight;

    let left = a.left;
    left = Math.min(left, window.innerWidth - MENU_WIDTH - EDGE);
    left = Math.max(EDGE, left);

    let top = a.bottom + GAP;
    if (top + h > window.innerHeight - EDGE) {
      // Flip above; if there is no room either way, pin to the top edge.
      top = Math.max(EDGE, a.top - h - GAP);
    }

    setPos({ top, left });
  }, [anchor, selected, error]);

  // Focus the first option on open — the popover is a decision, so the
  // keyboard should land on the decision, not on the caption.
  useEffect(() => {
    optionRefs.current[0]?.focus();
  }, []);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  // Outside click. mousedown (not click) so a text-selection drag that starts
  // inside the note and releases outside does not destroy the form.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (menuRef.current?.contains(t)) return;
      if (anchor.contains(t)) return; // the anchor's own onClick owns the toggle
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, close]);

  // Esc anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // Scroll (capture, so nested scrollers count) + resize. A scroll that
  // originated INSIDE the menu is the user reading the note field, not the
  // page moving underneath the anchor.
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && menuRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [close]);

  // Roving focus across the three options.
  const onOptionKeyDown = (e: ReactKeyboardEvent, index: number) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = (index + delta + OUTCOME_ORDER.length) % OUTCOME_ORDER.length;
    optionRefs.current[next]?.focus();
  };

  const submit = async () => {
    if (selected == null || busy) return;
    setBusy(true);
    setError('');
    try {
      const detail = await adminApi.recordLeadOutcome(leadId, {
        outcome: selected,
        // Tier only means anything on a sale; a stray tier on a rejection
        // would read as a lost deal size nobody quoted.
        sale_tier: selected === 'converted' && saleTier ? saleTier : null,
        note: note.trim() ? note.trim() : null,
      });
      onRecorded(detail);
      close();
    } catch (err) {
      setError(apiErrorDetail(err) ?? 'Could not record that outcome. Try again.');
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      role="dialog"
      aria-label={`Record call outcome for ${label}`}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: MENU_WIDTH,
        // OPACITY, not `visibility: hidden` — a visibility-hidden element is
        // not focusable, and the mount effect below focuses the first option
        // before this has necessarily flipped. pointer-events goes with it so
        // the un-positioned first frame can't eat a click at 0,0.
        opacity: pos ? 1 : 0,
        pointerEvents: pos ? 'auto' : 'none',
      }}
    >
      <p className={styles.caption}>
        <span className={styles.captionLabel}>Outcome</span>
        <span className={styles.captionName}>{label}</span>
      </p>

      <div className={styles.options}>
        {OUTCOME_ORDER.map((key, i) => {
          const meta = OUTCOME_META[key];
          const active = selected === key;
          return (
            <button
              key={key}
              type="button"
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              className={active ? `${styles.option} ${styles.optionActive}` : styles.option}
              // Fill-tuned hex goes to the GLYPH DISC (white type on a solid
              // disc reads on both themes); the word takes the ink pair so
              // dark mode lifts it (--oc-dark) instead of sinking to ~2:1.
              style={{ ...outcomeInkVars(meta), borderColor: active ? meta.hex : undefined }}
              aria-pressed={active}
              onClick={() => setSelected(key)}
              onKeyDown={(e) => onOptionKeyDown(e, i)}
            >
              <span
                className={styles.optionGlyph}
                style={{ background: meta.hex }}
                aria-hidden="true"
              >
                {meta.glyph}
              </span>
              <span className={styles.optionWord}>{meta.word}</span>
            </button>
          );
        })}
      </div>

      {selected != null && (
        <div className={styles.form}>
          {selected === 'converted' && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Tier sold (optional)</span>
              <select
                className={styles.select}
                value={saleTier}
                onChange={(e) => setSaleTier(e.target.value)}
              >
                <option value="">Not recorded</option>
                {SALE_TIERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span className={styles.fieldHint}>
                A label on the call record &mdash; billing still starts at the sponsors desk.
              </span>
            </label>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Note (optional)</span>
            <textarea
              className={styles.textarea}
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was said?"
            />
          </label>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="button" className={styles.confirm} onClick={submit} disabled={busy}>
            {busy ? 'Recording…' : 'Record outcome'}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
