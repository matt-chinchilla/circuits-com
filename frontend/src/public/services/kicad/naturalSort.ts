const SPLIT = /^([^\d]*)(\d*)(.*)$/;

/**
 * R2 before R10: compare the letter prefix, then the number, then the rest.
 *
 * The fallbacks are REACHABLE, contrary to how every group being `*`-quantified
 * reads. `.` does not match a line terminator and there is no `m` flag, so once
 * `(\d*)` has taken a digit the trailing `(.*)$` cannot get past a `\n` — and
 * backtracking cannot either, because `[^\d]*` will not cross the digit going
 * the other way. `exec` therefore returns null for "R1\n", "R1\nX", "R1\r\nX"
 * and "1\u20282" (measured). A designator reaches this from a `.kicad_sch`
 * property, and the tokenizer reads a quoted string up to its closing quote,
 * newlines and all — so a hand-edited or generated schematic really can hand us
 * one. Null-deref here would throw from inside a sort and take the BOM table
 * down; degrading to a whole-string text compare loses only the R2/R10 order
 * for a designator nobody meant to write. Pinned by `naturalSort.test.ts`.
 */
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
