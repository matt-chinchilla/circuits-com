// The guide's open/closed state, for the pieces that live inside the sheet and
// below it (a note marker in the compact card has to reopen the guide before
// it can scroll to its note).
import { createContext, useContext } from 'react';

export interface GuideControl {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const GuideContext = createContext<GuideControl>({ open: true, setOpen: () => {} });

export function useGuide(): GuideControl {
  return useContext(GuideContext);
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const noteId = (n: number): string => `note-${n}`;

/** Scroll to a note, move focus to it and light it briefly. */
export function goToNote(n: number): void {
  const el = document.getElementById(noteId(n));
  if (el == null) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
  el.setAttribute('data-lit', 'true');
  window.setTimeout(() => el.removeAttribute('data-lit'), 1800);
}
