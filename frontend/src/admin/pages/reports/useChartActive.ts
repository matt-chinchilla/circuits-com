import { useEffect, useState } from 'react';

/** Hover + click-to-pin state shared by the Reports line charts, with the
 *  stale-index bounds guard applied in one place.
 *
 *  Hover previews the tooltip; CLICKING a datapoint pins it so it survives
 *  mouse-out (owner requirement). Dismissal: click the same point again,
 *  click empty chart space, press Esc — and any data identity change
 *  (segment toggle, date range, demo mode) clears it automatically.
 *
 *  `active` (pinned beats hover) is bounds-clamped at render time: a
 *  range/segment switch shrinks `data` one render before the reset effect
 *  clears the stale index — never dereference past the new series
 *  (reproduced crash: pin idx 107 on 365d, switch to 30d). `pinned` is
 *  returned unclamped for the ring/marker `pinned === i` comparisons, which
 *  are index-matched and therefore safe by construction. */
export function useChartActive(data: readonly unknown[]): {
  active: number | null;
  pinned: number | null;
  setHover: (i: number | null) => void;
  togglePin: (i: number) => void;
  clearPin: () => void;
} {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  useEffect(() => {
    setPinned(null);
  }, [data]);

  useEffect(() => {
    if (pinned === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  const raw = pinned ?? hover;
  const active = raw !== null && raw < data.length ? raw : null;

  return {
    active,
    pinned,
    setHover,
    togglePin: (i: number) => setPinned((cur) => (cur === i ? null : i)),
    clearPin: () => setPinned(null),
  };
}
