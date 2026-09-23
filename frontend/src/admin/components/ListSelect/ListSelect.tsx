// The admin console's dropdown (2026-09-23). A native <select> hands its open
// menu to the operating system, which draws it grey and unstyled and strips
// any markup from an option — so the sales build's pickers (price, placement,
// company, expiry, rep) render through this listbox instead.
//
//   • Porcelain-glass menu (the house law: "menus and dialogs are near-opaque
//     porcelain glass", --a-glass-sheet), modelled on the macOS 27 menu: a
//     check column, a brand-green highlight row, group headers.
//   • PORTALED into the admin root ([data-admin-root]) with fixed positioning
//     measured from the trigger: the pickers live inside `overflow: hidden`
//     panels and dialogs that would clip an absolute popover, and portaling to
//     <body> would lose the --a-* tokens that .admin defines. Flips above the
//     trigger when there is more room there; repositions on scroll/resize.
//   • Keyboard: the APG listbox pattern — Arrow/Page/Home/End move, Enter
//     picks, Esc/Tab close. Without a search box, typing jumps (typeaheadMatch:
//     "5" → 5%, "12" → 12%, "da" → Daniel). `searchable` adds a filter field
//     for the long lists (placements, companies).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { typeaheadMatch } from './priceRows';
import styles from './ListSelect.module.scss';

export interface ListOption<V extends string | number> {
  value: V;
  /** Plain text — what screen readers announce, what typeahead and the filter match. */
  label: string;
  /** The rich row; defaults to `label`. */
  content?: ReactNode;
  /** Consecutive options sharing a group sit under one header. */
  group?: string;
  /** Exact typeahead keys ("5" jumps to the 5% row). */
  keys?: string[];
  disabled?: boolean;
}

interface Props<V extends string | number> {
  id?: string;
  value: V;
  options: ListOption<V>[];
  onChange: (value: V) => void;
  /** Needed only when no <label htmlFor={id}> names the trigger. */
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Adds a filter field — for lists too long to scan. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** How the closed trigger shows the chosen option (defaults to its content). */
  renderValue?: (option: ListOption<V> | null) => ReactNode;
  /** 'price' gives the trigger the taller price-row rhythm. */
  variant?: 'default' | 'price';
}

interface Placement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

const GAP = 6;
const MENU_MAX = 340;
// A menu hugs its rows like a macOS menu instead of spanning a full-width field.
const MENU_MIN_W = 260;
const MENU_MAX_W = 460;
const EDGE = 12;
const TYPEAHEAD_MS = 700;

function adminRoot(): HTMLElement {
  return (document.querySelector('[data-admin-root]') as HTMLElement | null) ?? document.body;
}

function Check() {
  return (
    <svg className={styles.check} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ListSelect<V extends string | number>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = 'Choose…',
  searchable = false,
  searchPlaceholder = 'Filter',
  renderValue,
  variant = 'default',
}: Props<V>) {
  const autoId = useId();
  const baseId = id ?? `ls${autoId.replace(/:/g, '')}`;
  const listId = `${baseId}-list`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Placement | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const typed = useRef({ buffer: '', at: 0 });

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || !q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.group ?? '').toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  // Measure against the trigger; prefer below, flip above when that side has
  // clearly more room.
  const measure = () => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const aboveRoom = r.top - GAP - EDGE;
    const above = below < Math.min(MENU_MAX, 240) && aboveRoom > below;
    const maxHeight = Math.max(160, Math.min(MENU_MAX, above ? aboveRoom : below));
    const width = Math.min(Math.max(Math.min(r.width, MENU_MAX_W), MENU_MIN_W), window.innerWidth - EDGE * 2);
    const left = Math.min(Math.max(EDGE, r.left), window.innerWidth - width - EDGE);
    setPlace({ top: above ? r.top - GAP : r.bottom + GAP, left, width, maxHeight, above });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onMove = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      measure();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  // Opening lands on the chosen row (or the first enabled one) and moves focus
  // into the menu so the keys below reach it.
  useEffect(() => {
    if (!open) return;
    const at = options.findIndex((o) => o.value === value);
    setActive(at >= 0 ? at : options.findIndex((o) => !o.disabled));
    requestAnimationFrame(() => (searchable ? searchRef.current : listRef.current)?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, baseId]);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (index: number) => {
    const option = visible[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };

  const step = (from: number, delta: number) => {
    if (visible.length === 0) return -1;
    let i = from;
    for (let n = 0; n < visible.length; n += 1) {
      i = Math.min(visible.length - 1, Math.max(0, i + delta));
      if (!visible[i].disabled) return i;
      if (i === 0 || i === visible.length - 1) break;
    }
    return from;
  };

  const onMenuKey = (e: KeyboardEvent<HTMLElement>) => {
    const inSearch = e.target === searchRef.current;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => step(a < 0 ? -1 : a, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => step(a < 0 ? visible.length : a, -1));
        return;
      case 'PageDown':
        e.preventDefault();
        setActive((a) => step(Math.min(visible.length - 1, Math.max(a, 0) + 7), 1));
        return;
      case 'PageUp':
        e.preventDefault();
        setActive((a) => step(Math.max(0, a - 7), -1));
        return;
      case 'Home':
        if (inSearch) return;
        e.preventDefault();
        setActive(step(-1, 1));
        return;
      case 'End':
        if (inSearch) return;
        e.preventDefault();
        setActive(step(visible.length, -1));
        return;
      case 'Enter':
        e.preventDefault();
        if (active >= 0) pick(active);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation(); // a dialog around us must not close too
        close();
        return;
      case 'Tab':
        close(false);
        return;
      default:
        break;
    }
    if (inSearch || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    const now = Date.now();
    const buffer = now - typed.current.at > TYPEAHEAD_MS ? e.key : typed.current.buffer + e.key;
    typed.current = { buffer, at: now };
    const hit = typeaheadMatch(buffer, visible);
    if (hit >= 0) setActive(hit);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  // Consecutive options with the same group render under one header.
  const segments = useMemo(() => {
    const out: { group: string; items: { option: ListOption<V>; index: number }[] }[] = [];
    visible.forEach((option, index) => {
      const group = option.group ?? '';
      const last = out[out.length - 1];
      if (last && last.group === group) last.items.push({ option, index });
      else out.push({ group, items: [{ option, index }] });
    });
    return out;
  }, [visible]);

  const activeId = active >= 0 && active < visible.length ? `${baseId}-opt-${active}` : undefined;

  const renderOption = (option: ListOption<V>, index: number) => {
    const isSelected = option.value === value;
    return (
      <div
        key={String(option.value)}
        id={`${baseId}-opt-${index}`}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        className={styles.option}
        data-active={index === active || undefined}
        onPointerMove={() => !option.disabled && setActive(index)}
        onClick={() => pick(index)}
      >
        <span className={styles.checkCol}>{isSelected && <Check />}</span>
        <span className={styles.optionBody}>{option.content ?? option.label}</span>
      </div>
    );
  };

  const menu =
    open && place
      ? createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            data-above={place.above || undefined}
            style={{
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
              ...(place.above ? { bottom: window.innerHeight - place.top } : { top: place.top }),
            }}
            onKeyDown={onMenuKey}
          >
            {searchable && (
              <div className={styles.searchWrap}>
                <input
                  ref={searchRef}
                  type="text"
                  className={styles.search}
                  placeholder={searchPlaceholder}
                  value={query}
                  autoComplete="off"
                  spellCheck={false}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeId}
                  aria-label={searchPlaceholder}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div
              ref={listRef}
              id={listId}
              className={styles.list}
              role="listbox"
              tabIndex={-1}
              aria-label={ariaLabel ?? placeholder}
              aria-activedescendant={searchable ? undefined : activeId}
            >
              {visible.length === 0 ? (
                <div className={styles.empty}>No matches</div>
              ) : (
                segments.map((seg, s) =>
                  seg.group ? (
                    <div key={`g${s}`} role="group" aria-label={seg.group} className={styles.group}>
                      <div className={styles.groupHead} aria-hidden="true">
                        {seg.group}
                      </div>
                      {seg.items.map(({ option, index }) => renderOption(option, index))}
                    </div>
                  ) : (
                    seg.items.map(({ option, index }) => renderOption(option, index))
                  ),
                )
              )}
            </div>
          </div>,
          adminRoot(),
        )
      : null;

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        data-variant={variant}
        data-open={open || undefined}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKey}
      >
        <span className={styles.value}>
          {renderValue
            ? renderValue(selected)
            : selected
              ? (selected.content ?? selected.label)
              : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu}
    </>
  );
}
