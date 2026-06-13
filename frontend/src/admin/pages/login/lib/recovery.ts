// Small client-side helpers for the recovery screens (ported from the v13
// design). `mask` only ever obscures what the user typed back to them — it is
// display-only and is NOT a security boundary (the backend is anti-enumeration).

const BULLET = '•'; // • — explicit escape so edit tooling can't mangle it

export const isEmail = (v: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export const mask = (v: string): string => {
  const s = v.trim();
  if (s.includes('@')) {
    const [u, d] = s.split('@');
    return `${u.slice(0, 2)}${BULLET.repeat(Math.max(1, u.length - 2))}@${d}`;
  }
  return `${s.slice(0, 2)}${BULLET.repeat(Math.max(2, s.length - 2))}`;
};
