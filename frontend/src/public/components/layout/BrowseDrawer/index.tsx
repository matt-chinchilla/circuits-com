import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { once } from "./once";
import styles from "./BrowseDrawer.module.scss";

// BrowseDrawer shell — always mounted in the Navbar so the burger's
// aria-controls="browse-drawer" reference never dangles. Owns the scrim, the
// dialog wrapper (which carries the slide transition, so the drawer animates
// even when the lazy body mounts a frame later) and the standard 3-effect
// drawer machine. The heavy body (rail + panes + data) is a separate lazy
// chunk loaded on first interaction.

type BodyProps = { open: boolean; onClose: () => void };
type BodyComponent = ComponentType<BodyProps>;

// NOT React.lazy on purpose: lazy caches a REJECTED import forever, which
// would leave the burger permanently dead after one failed chunk fetch.
// once() resets on rejection, so the next click is a genuine retry.
export const loadBrowseDrawerBody = once<BodyComponent>(() =>
  import("./BrowseDrawerBody").then((m) => m.default),
);

/** Hover/idle warm-up — failures here may be swallowed (the click path retries). */
export function prefetchBrowseDrawerBody(): void {
  loadBrowseDrawerBody().catch(() => {});
}

interface BrowseDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function BrowseDrawer({ open, onClose }: BrowseDrawerProps) {
  const location = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [Body, setBody] = useState<BodyComponent | null>(() => loadBrowseDrawerBody.peek());

  // Sync the loaded chunk into state. Navbar only opens after the load
  // resolved, so this settles from cache immediately; the catch is a guard
  // for the prefetch-failed-then-somehow-open race, not a swallow of the
  // click path (which handles rejection itself).
  useEffect(() => {
    if (!open || Body) return undefined;
    let cancelled = false;
    loadBrowseDrawerBody()
      .then((m) => {
        if (!cancelled) setBody(() => m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, Body]);

  // Effect 1/3: body scroll lock while open.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Effect 2/3: Esc closes — listener attached only while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Effect 3/3: route change closes (fires once on mount too — harmless,
  // closing an already-closed drawer is a no-op state bail).
  useEffect(() => {
    onClose();
  }, [location.pathname]);

  // Focus trap: Tab / Shift-Tab loop inside the dialog while open. `inert`
  // keeps the closed drawer out of the tab order entirely.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = wrapRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const scrimClass = [
    styles.scrim,
    open ? styles.isOpen : "",
    // Blur is withheld on the homepage: the scrim would re-filter the
    // continuously animating hero backdrop every frame.
    location.pathname !== "/" ? styles.scrimBlur : "",
  ]
    .filter(Boolean)
    .join(" ");
  const drawerClass = open ? `${styles.drawer} ${styles.isOpen}` : styles.drawer;

  return (
    <>
      <div className={scrimClass} onClick={onClose} aria-hidden="true" />
      <div
        id="browse-drawer"
        ref={wrapRef}
        className={drawerClass}
        role="dialog"
        aria-modal="true"
        aria-label="Browse"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={onKeyDown}
      >
        {Body ? <Body open={open} onClose={onClose} /> : null}
      </div>
    </>
  );
}
