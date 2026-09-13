/** `TableRow.viewerHref` is the viewer ROUTE; the chip appends the reference
 *  as a hash the viewer page reads on mount (spec §6). One home for the
 *  composition so the two sides cannot drift.
 *
 *  `encodeURIComponent` is the pair of the viewer page's `decodeURIComponent`
 *  on `location.hash.slice(1)`: a hierarchical designator ("U1/2") would
 *  otherwise be read back as a path, and a base that already carries a query
 *  ("/viewer?doc=x") keeps it — the hash is appended, never substituted. */
export function viewerRefHref(base: string, ref: string): string {
  return `${base}#${encodeURIComponent(ref)}`;
}
