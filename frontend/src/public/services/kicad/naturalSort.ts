const SPLIT = /^([^\d]*)(\d*)(.*)$/;

/** R2 before R10: compare the letter prefix, then the number, then the rest. */
export function naturalRefCompare(a: string, b: string): number {
  const ma = SPLIT.exec(a) ?? [a, a, '', ''];
  const mb = SPLIT.exec(b) ?? [b, b, '', ''];
  const prefix = (ma[1] ?? '').localeCompare(mb[1] ?? '', 'en');
  if (prefix !== 0) return prefix;
  const na = ma[2] === '' ? -1 : Number(ma[2]);
  const nb = mb[2] === '' ? -1 : Number(mb[2]);
  if (na !== nb) return na - nb;
  return (ma[3] ?? '').localeCompare(mb[3] ?? '', 'en');
}
