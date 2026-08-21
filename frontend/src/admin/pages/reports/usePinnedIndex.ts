import { useEffect, useState } from 'react';

/** Click-to-pin state shared by the Reports line charts.
 *
 *  Hover previews the tooltip; CLICKING a datapoint pins it so it survives
 *  mouse-out (owner requirement). Dismissal: click the same point again,
 *  click empty chart space, press Esc — and any data identity change
 *  (segment toggle, date range, demo mode) clears it automatically. */
export function usePinnedIndex(dataKey: unknown): {
  pinned: number | null;
  togglePin: (i: number) => void;
  clearPin: () => void;
} {
  const [pinned, setPinned] = useState<number | null>(null);

  useEffect(() => {
    setPinned(null);
  }, [dataKey]);

  useEffect(() => {
    if (pinned === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  return {
    pinned,
    togglePin: (i: number) => setPinned((cur) => (cur === i ? null : i)),
    clearPin: () => setPinned(null),
  };
}
