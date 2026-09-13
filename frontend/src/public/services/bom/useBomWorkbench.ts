// Everything that happens to a BOM after it is parsed: the phase-1 match, the
// phase-2 resolve stream, build quantity, the DNP toggle, the similar-pick.
// Moved from pages/bom/index.tsx so /viewer prices a schematic-derived BOM
// with the same code (spec §6). No behaviour change intended; the pure pieces
// are exported and unit-tested, the hook is the wiring.
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { bomApi } from './bomApi';
import type { ParsedBomLine, ParseResult } from './parseBom';
import type { BomRow, MissIn, ResolveEvent, TableRow } from './types';

export const MATCH_FAILED =
  'We could not reach the pricing service. Your file is still loaded — try again in a moment.';
export const MATCH_THROTTLED =
  'That is a lot of BOMs in one minute. Wait about a minute and price this one again.';

/** Mirrors `BomResolveRequest.misses` max_length in api/app/schemas/bom.py:
 *  one over and the server 422s the whole stream, so the cap is enforced here
 *  and ANNOUNCED — a silently dropped line is a line the reader believes was
 *  priced. */
export const RESOLVE_CAP = 50;

export const RESOLVE_STOPPED =
  'Live lookups stopped early. The lines still marked NO MATCH were never looked up — try again in a moment.';

export function cappedNote(dropped: number): string {
  const lines = dropped === 1 ? 'line was' : 'lines were';
  return (
    `Live lookups are capped at ${RESOLVE_CAP} lines per BOM — ` +
    `${dropped.toLocaleString('en-US')} further unmatched ${lines} left unresolved. ` +
    'Request a quote for those lines.'
  );
}

/**
 * Which lines phase 2 asks a distributor about, in the order it asks.
 *
 * MPN'd misses go FIRST: they resolve by an exact part lookup, which is the
 * one call that either finds the part or proves it does not exist. A
 * value+footprint query ("10k 0805") is a keyword search whose first hit is a
 * guess, so when the cap bites it is the guesses that get dropped, never the
 * certainties.
 *
 * DNP lines are not asked about unless the reader has said to include them
 * (spec §5) — nobody is buying them, and a live lookup costs real distributor
 * quota. The toggle is read at the moment the stream STARTS: flipping it
 * afterwards re-counts and re-prices the table from data already in hand, but
 * it never goes and spends more quota behind the reader's back.
 */
export function pickMisses(
  rows: TableRow[],
  includeDnp: boolean,
): { misses: MissIn[]; dropped: number } {
  const withMpn: MissIn[] = [];
  const withoutMpn: MissIn[] = [];
  for (const row of rows) {
    const server = row.server;
    if ((row.dnp && !includeDnp) || server == null || server.status !== 'resolve') continue;
    const query = server.resolve_query;
    if (query == null || query.trim() === '') continue;
    const mpn = row.mpn != null && row.mpn.trim() !== '' ? row.mpn : null;
    (mpn != null ? withMpn : withoutMpn).push({ index: row.index, query, mpn });
  }
  const ordered = [...withMpn, ...withoutMpn];
  return {
    misses: ordered.slice(0, RESOLVE_CAP),
    dropped: Math.max(0, ordered.length - RESOLVE_CAP),
  };
}

/**
 * Phase-1 rows: `matched` means "the server answered"; `not_found` means it
 * did not. The badge then reads the server status, so a `resolve`/`none` row
 * is still `matched` in this sense and simply renders NO MATCH until phase 2
 * moves it.
 *
 * `viewerHref` is the §7.6 seam: null on the standalone tool, a route when a
 * viewer session is what produced these lines.
 */
export function buildRows(
  lines: ParsedBomLine[],
  serverRows: BomRow[],
  viewerHref: string | null,
): TableRow[] {
  const byIndex = new Map(serverRows.map((row) => [row.index, row]));
  return lines.map((line) => {
    const server = byIndex.get(line.index) ?? null;
    return {
      ...line,
      server,
      state: server == null ? ('not_found' as const) : ('matched' as const),
      viewerHref,
    };
  });
}

/** Fold one streamed event into the row it names. Pure so the caller can hand
 *  it to a functional updater: events arrive over tens of seconds and the
 *  closure that started the stream has long since gone stale. */
export function applyResolveEvent(rows: TableRow[], event: ResolveEvent): TableRow[] {
  return rows.map((row) => {
    if (row.index !== event.index) return row;
    switch (event.kind) {
      case 'resolved':
        // A `resolved` with no row is a malformed event; falling back to the
        // phase-1 answer is honest, a permanent spinner is not.
        return event.row == null
          ? { ...row, state: 'matched' as const }
          : { ...row, server: event.row, state: 'resolved_live' as const };
      case 'not_found':
        return { ...row, state: 'not_found' as const };
      case 'resolve_unavailable':
        return { ...row, state: 'unavailable' as const };
      default:
        return row;
    }
  });
}

/** The server emits exactly one event per miss, so nothing should still be
 *  spinning once the stream ends. If something is, the stream died early —
 *  put the row back on its phase-1 answer rather than spin forever. */
export function settleStragglers(rows: TableRow[]): TableRow[] {
  return rows.map((row) => (row.state === 'resolving' ? { ...row, state: 'matched' as const } : row));
}

/** The Matches column's "Similar" pick applied: the fresh match replaces the
 *  answer as approx (relative to what was SUBMITTED it is still a substitute),
 *  the displaced part joins the menu, so the pick stays reversible. */
export function foldSimilarPick(
  rows: TableRow[],
  rowIndex: number,
  sku: string,
  fresh: BomRow,
): TableRow[] {
  if (fresh.part == null) return rows;
  return rows.map((r) => {
    if (r.index !== rowIndex || r.server == null) return r;
    const displaced = r.server.part;
    const keptSimilar = [
      ...(displaced != null
        ? [
            {
              id: displaced.id,
              sku: displaced.sku,
              manufacturer_name: displaced.manufacturer_name,
              description: displaced.description,
              package: displaced.package,
              lifecycle_status: displaced.lifecycle_status,
              lifecycle_verified: displaced.lifecycle_verified,
            },
          ]
        : []),
      ...r.server.similar,
    ].filter((s) => s.sku !== sku);
    return {
      ...r,
      server: {
        ...fresh,
        status: 'approx' as const,
        approx_reason: 'your pick — similar part',
        similar: keptSimilar,
      },
    };
  });
}

export interface BomWorkbench {
  rows: TableRow[];
  matching: boolean;
  matchError: string | null;
  resolveNote: string | null;
  resolveError: string | null;
  buildQty: number;
  setBuildQty: (qty: number) => void;
  includeDnp: boolean;
  setIncludeDnp: (include: boolean) => void;
  pickSimilar: (rowIndex: number, sku: string) => void;
  /**
   * Back to nothing: abandons every in-flight request, aborts the stream and
   * clears every field INCLUDING the reader's build quantity and DNP choice.
   *
   * Distinct from handing the hook `null`, which means "nothing to price right
   * now" — that clears the priced result but KEEPS those two settings, so a
   * consumer that re-derives a BOM (closing and reopening a project) does not
   * silently reset the quantity somebody typed.
   */
  reset: () => void;
}

/**
 * @param parsed  The BOM to price, or null for "nothing to price right now" —
 *   which clears any previous result and abandons work in flight. Phase 1 runs
 *   once per IDENTITY of this object, so callers hold it in state, never
 *   rebuild it per render.
 * @param viewerHref  Stamped onto every row (the §7.6 seam) and nothing else.
 *   Deliberately NOT a match input: it may arrive late — `/bom` gains one when
 *   a KiCad project is opened mid-session — and re-matching then would bin a
 *   priced table and re-spend the visitor's daily resolve budget. A change
 *   re-stamps the rows already on screen instead.
 */
export function useBomWorkbench(
  parsed: ParseResult | null,
  viewerHref: string | null,
): BomWorkbench {
  const [rows, setRows] = useState<TableRow[]>([]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [buildQty, setBuildQty] = useState(1);
  // Per-BOM, default OFF (spec §5). A ref shadows it because `startResolve`
  // runs from the phase-1 effect and must read the CURRENT answer without
  // re-running the whole match when the reader toggles it.
  const [includeDnp, setIncludeDnp] = useState(false);
  const includeDnpRef = useRef(includeDnp);
  includeDnpRef.current = includeDnp;
  // Phase-2 notes, kept apart from `matchError` because neither is fatal: the
  // table is priced and readable with both of them on screen.
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  /**
   * THE staleness mechanism. Every async landing answers one question — "does
   * this belong to a workbench that still exists?" — by comparing the
   * generation it was issued under against the current one. Bumped by the four
   * things that end a workbench: a new `parsed`, its teardown, `reset()` and
   * unmount.
   *
   * It replaces an effect-local `cancelled` flag, which `reset()` could not
   * reach: a match landing after a clear used to repopulate the emptied table
   * AND open a fresh stream, spending up to RESOLVE_CAP of the visitor's
   * 100/day resolve budget on a BOM they had just thrown away.
   */
  const genRef = useRef(0);

  /** Read at `buildRows` time rather than depended on — see the doc comment. */
  const viewerHrefRef = useRef(viewerHref);
  viewerHrefRef.current = viewerHref;

  const pickSeqRef = useRef(new Map<number, number>());

  // The resolve stream is a socket THIS tab holds open. Leaving the page drops
  // it; each miss is one bounded server-side call that finishes on its own
  // either way, so aborting costs nothing but the reader. One controller is
  // enough: one stream at a time.
  const resolveAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      genRef.current += 1;
      resolveAbort.current?.abort();
    },
    [],
  );

  /**
   * Phase 2 — the misses go and heal themselves.
   *
   * Owns the `setRows` for the rows it is about to ask about (flipping them to
   * `resolving` in the SAME commit the table first renders in, so no row ever
   * flashes NO MATCH on its way to being looked up).
   */
  const startResolve = useCallback((built: TableRow[]) => {
    // Called synchronously from the match landing, which has already proved
    // its generation current, so reading it here captures the same one.
    const gen = genRef.current;
    const { misses, dropped } = pickMisses(built, includeDnpRef.current);
    setResolveNote(dropped > 0 ? cappedNote(dropped) : null);
    setResolveError(null);
    if (misses.length === 0) {
      setRows(built);
      return;
    }

    const asking = new Set(misses.map((m) => m.index));
    setRows(
      built.map((row) => (asking.has(row.index) ? { ...row, state: 'resolving' as const } : row)),
    );

    // Never two readers on one table: a fresh parse drops the older socket.
    resolveAbort.current?.abort();
    const controller = new AbortController();
    resolveAbort.current = controller;

    bomApi
      .streamResolve(
        misses,
        (event) => {
          // Events buffered before the abort can still arrive. They name row
          // INDICES, so replaying one onto a later BOM would stamp a live
          // price on whatever line happens to sit at that index.
          if (genRef.current !== gen) return;
          setRows((prev) => applyResolveEvent(prev, event));
        },
        controller.signal,
      )
      .then(() => {
        if (genRef.current !== gen) return;
        setRows(settleStragglers);
      })
      .catch(() => {
        // An abort resolves down this path too; there is nobody left to tell.
        if (genRef.current !== gen) return;
        setRows(settleStragglers);
        setResolveError(RESOLVE_STOPPED);
      });
  }, []);

  // Phase 1: ask the catalog about the identity fields, once, per parse —
  // keyed on the IDENTITY of `parsed`, which callers hold in state or in the
  // session. A caller that is not ready to price passes null.
  //
  // The table is deliberately NOT rendered while this is in flight: rows with
  // no server answer yet would all read NO MATCH, which is a lie for the
  // second and a half it takes to come back.
  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;

    // Nothing to price: abandon the previous BOM's result rather than leave it
    // rendered under a consumer that has closed its project. The build
    // quantity and DNP choice survive — they are the reader's settings, and
    // only `reset()` owns those. The functional updater keeps the array
    // identity when it is already empty, so a null-armed hook never re-renders.
    if (parsed == null || parsed.error != null) {
      resolveAbort.current?.abort();
      setRows((prev) => (prev.length === 0 ? prev : []));
      setMatching(false);
      setMatchError(null);
      setResolveNote(null);
      setResolveError(null);
      return;
    }

    const lines = parsed.lines;
    setRows([]);
    setMatchError(null);
    setMatching(true);

    // D7: IDENTITY FIELDS ONLY. Quantities, designators, the DNP flag and the
    // file itself never leave the browser — the privacy claim is structural,
    // not a promise, and the /bom/match schema rejects anything else. Pricing
    // math runs client-side off the break tables the response carries back.
    bomApi
      .match(
        lines.map((line) => ({
          index: line.index,
          mpn: line.mpn,
          value: line.value,
          footprint: line.footprint,
          description: line.description,
          manufacturer: line.manufacturer,
        })),
      )
      .then((serverRows) => {
        if (genRef.current !== gen) return;
        setMatching(false);
        // Hand the rows straight to phase 2 — it owns the setRows, so the
        // lines it is about to look up land already flipped to `resolving`.
        startResolve(buildRows(lines, serverRows, viewerHrefRef.current));
      })
      .catch((err: unknown) => {
        if (genRef.current !== gen) return;
        const throttled = axios.isAxiosError(err) && err.response?.status === 429;
        setMatchError(throttled ? MATCH_THROTTLED : MATCH_FAILED);
        setMatching(false);
      });

    return () => {
      // A new parse invalidates the previous BOM's stream as surely as
      // leaving does — its events name row indices from a table that no
      // longer exists.
      genRef.current += 1;
      resolveAbort.current?.abort();
    };
  }, [parsed, startResolve]);

  // A viewer route that arrives after the table is priced re-stamps the rows
  // in place. Bailing out on `every` keeps the array identity when nothing
  // changed, so the common case (a stable href, or none) costs one comparison
  // pass and no re-render.
  useEffect(() => {
    setRows((prev) =>
      prev.every((row) => row.viewerHref === viewerHref)
        ? prev
        : prev.map((row) => ({ ...row, viewerHref })),
    );
  }, [viewerHref]);

  /**
   * Re-match this ONE line by the chosen SKU (identity only travels — D7).
   *
   * Two guards, because they answer different questions. The generation says
   * the answer still belongs to THIS BOM — without it a pick made before
   * "Change file" lands on the next BOM's row of the same index and labels
   * somebody else's part "your pick". The per-row sequence says it is still
   * the LATEST pick for that row; overlapping picks settle in network order,
   * so a superseded response must be dropped, not applied (review #4). The
   * generation cannot express that — both clicks share one generation.
   */
  const pickSimilar = useCallback(
    (rowIndex: number, sku: string) => {
      const gen = genRef.current;
      const line = rows.find((r) => r.index === rowIndex);
      const seq = (pickSeqRef.current.get(rowIndex) ?? 0) + 1;
      pickSeqRef.current.set(rowIndex, seq);
      bomApi
        .match([
          {
            index: rowIndex,
            mpn: sku,
            value: null,
            footprint: line?.footprint ?? null,
            description: null,
            manufacturer: null,
          },
        ])
        .then(([fresh]) => {
          if (genRef.current !== gen) return; // another BOM, or cleared
          if (pickSeqRef.current.get(rowIndex) !== seq || fresh == null) return; // superseded
          setRows((prev) => foldSimilarPick(prev, rowIndex, sku, fresh));
        })
        .catch((err) => {
          if (genRef.current !== gen) return; // another BOM, or cleared
          if (pickSeqRef.current.get(rowIndex) !== seq) return; // superseded
          const throttled = axios.isAxiosError(err) && err.response?.status === 429;
          setResolveError(
            throttled ? MATCH_THROTTLED : 'Could not switch to that part — try again in a moment.',
          );
        });
    },
    [rows],
  );

  const reset = useCallback(() => {
    // Bump FIRST: a match already on the wire must not repopulate the table we
    // are about to clear, nor open a stream against it.
    genRef.current += 1;
    resolveAbort.current?.abort();
    pickSeqRef.current.clear();
    setRows([]);
    setMatchError(null);
    setMatching(false);
    setResolveNote(null);
    setResolveError(null);
    setBuildQty(1);
    setIncludeDnp(false);
  }, []);

  return {
    rows,
    matching,
    matchError,
    resolveNote,
    resolveError,
    buildQty,
    setBuildQty,
    includeDnp,
    setIncludeDnp,
    pickSimilar,
    reset,
  };
}
