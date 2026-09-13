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

/**
 * Priced results, keyed by the PARSE they belong to.
 *
 * A hook instance dies with its page, and /viewer → /bom is two pages holding
 * the SAME `parsed` object (the design session's). Without this the second
 * mount re-issues the match the first already paid for and opens a second
 * resolve stream, re-spending up to RESOLVE_CAP of the visitor's 100-a-day
 * budget on lines that came back a minute ago. An SPA return to /viewer's BOM
 * tab is the same trip.
 *
 * A WeakMap, so the entry's lifetime IS the ParseResult's — it dies with the
 * design session that holds the parse, needs no TTL and cannot collide with
 * another BOM that happens to share a header signature. `reset()` drops it
 * explicitly: that is the reader saying this answer is finished with.
 *
 * Deliberately not a cache of the NETWORK. It is keyed on object identity, so
 * re-reading the same file (a fresh ParseResult) prices again — nothing here
 * can serve a price from a session the reader has already closed.
 */
interface PricedSnapshot {
  rows: TableRow[];
  resolveNote: string | null;
  resolveError: string | null;
}

const priced = new WeakMap<ParseResult, PricedSnapshot>();

/**
 * File a priced answer against its parse.
 *
 * An EMPTY table is never one. A priced BOM has at least one row by
 * construction — the zero-line guard means `lines.length >= 1` and `buildRows`
 * maps over `lines` — so `rows: []` here can only be the teardown ref caught
 * mid-restore, before the queued `setRows` has committed. StrictMode's
 * mount-only double-invoke (`main.tsx` enables it, so every dev session) opens
 * that window deterministically: restore → cleanup → restore, with the second
 * restore reading a snapshot the first had just blanked. Refusing the write is
 * the whole guard.
 *
 * Rows still `resolving` are SETTLED on the way in — one would otherwise be
 * restored spinning forever with no stream behind it — and their presence is
 * itself a fact the reader needs: those lines were never looked up. Restored
 * bare they read NO MATCH, which says the catalog does not carry the part.
 * `RESOLVE_STOPPED` is the sentence that already owns this, so the snapshot
 * carries it rather than the `null` a healthy stream leaves behind.
 */
function remember(
  target: ParseResult | null,
  rows: TableRow[],
  resolveNote: string | null,
  resolveError: string | null,
): void {
  if (target == null || rows.length === 0) return;
  const stopped = rows.some((row) => row.state === 'resolving');
  priced.set(target, {
    rows: settleStragglers(rows),
    resolveNote,
    resolveError: stopped ? RESOLVE_STOPPED : resolveError,
  });
}

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
   * TERMINAL for the current `parsed`: pricing does not resume on its own, by
   * design — re-issuing a match the reader just cancelled would spend the
   * resolve budget they declined. The hook prices again only when `parsed`
   * changes IDENTITY, so hand in a fresh parse, or `null` and then the same
   * one back.
   *
   * Distinct from handing the hook `null`, which means "nothing to price right
   * now" — that clears the priced result but KEEPS those two settings, so a
   * consumer that re-derives a BOM (closing and reopening a project) does not
   * silently reset the quantity somebody typed. Null-arming is the better lever
   * for "close the project"; `reset()` is "change file".
   */
  reset: () => void;
}

/**
 * Phase 1 runs at most once per IDENTITY of `parsed`, ACROSS MOUNTS: the priced
 * answer is snapshotted against the parse object itself (see `priced` above), so
 * a second page holding the same parse — /bom continuing a /viewer session, or
 * an SPA return to the viewer's BOM tab — restores the table with no network at
 * all. The snapshot's lifetime is the parse object's, which is the design
 * session's; `reset()` drops it.
 *
 * @param parsed  The BOM to price, or null for "nothing to price right now" —
 *   which clears any previous result and abandons work in flight. A parse with
 *   an error, or with NO LINES, is treated exactly as null: `/bom/match` rejects
 *   an empty `lines` array (min_length=1), so asking would buy a 422 and render
 *   it to the reader as "we could not reach the pricing service". Callers hold
 *   this object in state, never rebuild it per render.
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

  /**
   * Has phase 1 ANSWERED for the current `parsed`? The snapshot guard: an empty
   * table recorded while the match is still on the wire would be restored, on
   * the next mount, as "this BOM priced to nothing".
   */
  const landedRef = useRef(false);

  /** What the teardown snapshot reads — the last COMMITTED state, since an
   *  unmount cleanup with `[]` deps closes over the first render. Assigned
   *  during render, like the two refs above. */
  const latest = useRef<{
    parsed: ParseResult | null;
    rows: TableRow[];
    note: string | null;
    error: string | null;
  }>({ parsed: null, rows: [], note: null, error: null });
  latest.current = { parsed, rows, note: resolveNote, error: resolveError };

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
      // Leaving MID-STREAM keeps whatever did come back; `remember` settles the
      // rows still waiting onto their phase-1 answer, exactly as a stream that
      // died would. The settled commits are snapshotted by the effect below —
      // this is the one case that never reaches a settled commit.
      if (landedRef.current) {
        const last = latest.current;
        remember(last.parsed, last.rows, last.note, last.error);
      }
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
    landedRef.current = false;

    // Nothing to price: abandon the previous BOM's result rather than leave it
    // rendered under a consumer that has closed its project. The build
    // quantity and DNP choice survive — they are the reader's settings, and
    // only `reset()` owns those. The functional updater keeps the array
    // identity when it is already empty, so a null-armed hook never re-renders.
    //
    // A parse with no LINES lands here too, and that is the point: the server's
    // `BomMatchRequest.lines` is min_length=1, so asking about an empty BOM is a
    // guaranteed 422 that the catch below would render as "we could not reach
    // the pricing service" — blaming the network for a schematic that simply had
    // nothing in it. A zero-line BOM is a state, not a failure.
    if (parsed == null || parsed.error != null || parsed.lines.length === 0) {
      resolveAbort.current?.abort();
      setRows((prev) => (prev.length === 0 ? prev : []));
      setMatching(false);
      setMatchError(null);
      setResolveNote(null);
      setResolveError(null);
      return;
    }

    // Already priced under this exact parse — restore it and ask nobody. This
    // is what makes the /viewer → /bom round trip cost ONE match: the second
    // page holds the session's parse, not a copy of it.
    const snapshot = priced.get(parsed);
    if (snapshot != null) {
      landedRef.current = true;
      setRows(snapshot.rows);
      setMatching(false);
      setMatchError(null);
      setResolveNote(snapshot.resolveNote);
      setResolveError(snapshot.resolveError);
      // No cleanup: nothing was started, and bumping the generation here would
      // invalidate the restored answer on the next render.
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
        landedRef.current = true;
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

  /**
   * Keep the snapshot current. Every commit where phase 1 has answered and
   * nothing is still in flight IS an answer worth returning to — the match
   * landing, a stream that found nothing to ask about, the stream settling, and
   * a re-stamped `viewerHref` all arrive here.
   *
   * Mid-stream commits are skipped: a row still waiting is not an answer, and
   * re-recording the whole table on each of up to RESOLVE_CAP events is work
   * nobody reads. The teardown above is what catches a reader who leaves while
   * the stream is running.
   */
  useEffect(() => {
    if (!landedRef.current || matching) return;
    if (rows.some((row) => row.state === 'resolving')) return;
    remember(parsed, rows, resolveNote, resolveError);
  }, [parsed, rows, matching, resolveNote, resolveError]);

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
    // The reader is finished with this answer, so the snapshot goes with it —
    // otherwise handing the same `parsed` back would restore the very table
    // they just cleared, out of a cache they cannot see.
    landedRef.current = false;
    if (latest.current.parsed != null) priced.delete(latest.current.parsed);
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
