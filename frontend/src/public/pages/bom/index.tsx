import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { Link, useParams } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import type { PageSeo } from '@public/services/seo';
import BomIntake from './components/BomIntake';
import ShareBar, { formatShareDate } from './components/ShareBar';
import BomTable from './components/BomTable';
import ColumnMapper, { canPrice } from './components/ColumnMapper';
import { bomApi } from './lib/bomApi';
import { applyRoleMap, type ParseResult } from './lib/parseBom';
import { loadRoleMap, saveRoleMap } from './lib/mapMemory';
import { parseSharePayload } from './lib/share';
import type { BomRole } from './lib/headerAliases';
import type { MissIn, ResolveEvent, TableRow } from './lib/types';
import styles from './BomPage.module.scss';

/**
 * BOM pricing tool — the page shell and its phase machine.
 *
 * One component serves two routes: `/bom` (the tool) and `/bom/s/:slug` (a
 * read-only share). The share view is per-user content, so it declares
 * noindex — the sitemap and the prerender cover `/bom` only.
 *
 * Phases are deliberately explicit rather than derived from "is there a parse
 * result": the mapper (Task 15) is entered from a COMPLETE parse whose columns
 * are ambiguous, so "parsed" and "ready to price" are different facts.
 *
 * Ownership: the intake reads and parses; every result of that read lands
 * HERE. The source text is held in a ref because the mapper re-materializes
 * the SAME text with the roles the user picks (applyRoleMap) rather than
 * asking for the file again — it is input to a handler, never render data.
 */

type Phase = 'intake' | 'mapping' | 'table';

/** `/bom/s/:slug` only: fetching, readable, or gone. */
type ShareState = 'loading' | 'ready' | 'missing';

/** The share view must never be indexed: it is somebody's parts list, and a
 *  self-canonical would put it in the index next to the tool itself. */
const SHARE_SEO: PageSeo = {
  ...STATIC_PAGE_SEO.bom,
  canonical: null,
  robots: 'noindex, follow',
};

/** The mapper exists for ONE question: which column identifies the part? A
 *  BOM with neither an MPN nor a value column cannot be priced, so that — not
 *  the presence of unmapped extras like `Price` or `LCSC#` — is the trigger.
 *  `canPrice` is that floor, shared with the mapper's Continue button. */
function needsMapping(result: ParseResult): boolean {
  return !canPrice(result.roleByColumn);
}

const MATCH_FAILED =
  'We could not reach the pricing service. Your file is still loaded — try again in a moment.';
const MATCH_THROTTLED =
  'That is a lot of BOMs in one minute. Wait about a minute and price this one again.';

/** Mirrors `BomResolveRequest.misses` max_length in api/app/schemas/bom.py:
 *  one over and the server 422s the whole stream, so the cap is enforced here
 *  and ANNOUNCED — a silently dropped line is a line the reader believes was
 *  priced. */
const RESOLVE_CAP = 50;

const RESOLVE_STOPPED =
  'Live lookups stopped early. The lines still marked NO MATCH were never looked up — try again in a moment.';

function cappedNote(dropped: number): string {
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
function pickMisses(
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

export default function BomPage() {
  const { slug } = useParams<{ slug?: string }>();
  const isShare = slug != null;

  const [phase, setPhase] = useState<Phase>('intake');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [mapRoles, setMapRoles] = useState<(BomRole | null)[]>([]);
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
  const pickSeqRef = useRef(new Map<number, number>());
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  /** The Matches column's "Similar" pick: re-match this ONE line by the
   *  chosen SKU (identity only travels — D7), keep the row's approx framing
   *  (relative to what was SUBMITTED it is still a substitute), and fold the
   *  displaced match back into the menu so the choice stays reversible. */
  const pickSimilar = (rowIndex: number, sku: string) => {
    const line = rows.find((r) => r.index === rowIndex);
    // Last click wins, PER ROW: overlapping picks settle in network order,
    // so a superseded response must be dropped, not applied (review #4).
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
        if (pickSeqRef.current.get(rowIndex) !== seq) return; // superseded
        if (fresh == null || fresh.part == null) return;
        setRows((prev) =>
          prev.map((r) => {
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
          }),
        );
      })
      .catch((err) => {
        if (pickSeqRef.current.get(rowIndex) !== seq) return; // superseded
        const throttled = axios.isAxiosError(err) && err.response?.status === 429;
        setResolveError(
          throttled ? MATCH_THROTTLED : 'Could not switch to that part — try again in a moment.',
        );
      });
  };
  const sourceText = useRef('');

  // The share view is its own small machine: one GET, then either a read-only
  // table or the dead-link state. `unreadable` is folded into `missing` on
  // purpose — a link whose payload this build cannot parse is, to the reader,
  // exactly as useful as one that expired.
  const [shareState, setShareState] = useState<ShareState>(isShare ? 'loading' : 'ready');
  const [shareExpiry, setShareExpiry] = useState<string | null>(null);

  // The resolve stream is a socket THIS tab holds open. Leaving the page — or
  // landing on a different share slug — drops it; each miss is one bounded
  // server-side call that finishes on its own either way, so aborting costs
  // nothing but the reader. One controller is enough: one stream at a time.
  const resolveAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      resolveAbort.current?.abort();
    },
    [slug],
  );

  // Hydrate a shared BOM. No intake, no mapper, and deliberately NO resolve:
  // the reader of a share did not upload this file, and spending distributor
  // quota on somebody else's BOM every time a link is opened is not theirs to
  // spend. The table renders the answers the BOM was shared with.
  useEffect(() => {
    if (slug == null) return;
    let cancelled = false;
    setShareState('loading');
    bomApi
      .getShare(slug)
      .then((envelope) => {
        if (cancelled) return;
        const hydrated = parseSharePayload(envelope.payload);
        if (hydrated == null) {
          setShareState('missing');
          return;
        }
        setRows(hydrated.rows);
        setBuildQty(hydrated.buildQty);
        setIncludeDnp(hydrated.includeDnp);
        setShareExpiry(envelope.expires_at);
        setShareState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setShareState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Fold one streamed event into the row it names. Functional updater on
  // purpose: events arrive over tens of seconds and the closure that started
  // the stream has long since gone stale.
  const applyResolveEvent = (event: ResolveEvent) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.index !== event.index) return row;
        switch (event.kind) {
          case 'resolved':
            // A `resolved` with no row is a malformed event; falling back to
            // the phase-1 answer is honest, a permanent spinner is not.
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
      }),
    );
  };

  /** The server emits exactly one event per miss, so nothing should still be
   *  spinning once the stream ends. If something is, the stream died early —
   *  put the row back on its phase-1 answer rather than spin forever. */
  const settleStragglers = () => {
    setRows((prev) =>
      prev.map((row) => (row.state === 'resolving' ? { ...row, state: 'matched' as const } : row)),
    );
  };

  /**
   * Phase 2 — the misses go and heal themselves.
   *
   * Owns the `setRows` for the rows it is about to ask about (flipping them to
   * `resolving` in the SAME commit the table first renders in, so no row ever
   * flashes NO MATCH on its way to being looked up).
   */
  const startResolve = (built: TableRow[]) => {
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
      .streamResolve(misses, applyResolveEvent, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        settleStragglers();
      })
      .catch(() => {
        // An abort resolves down this path too; there is nobody left to tell.
        if (controller.signal.aborted) return;
        settleStragglers();
        setResolveError(RESOLVE_STOPPED);
      });
  };

  // Phase 1: ask the catalog about the identity fields, once, per parse.
  //
  // The table is deliberately NOT rendered while this is in flight: rows with
  // no server answer yet would all read NO MATCH, which is a lie for the
  // second and a half it takes to come back.
  useEffect(() => {
    if (phase !== 'table' || parsed == null) return;
    const lines = parsed.lines;
    setRows([]);
    setMatchError(null);
    setMatching(true);
    let cancelled = false;

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
        if (cancelled) return;
        const byIndex = new Map(serverRows.map((row) => [row.index, row]));
        const built: TableRow[] = lines.map((line) => {
          const server = byIndex.get(line.index) ?? null;
          return {
            ...line,
            server,
            // `matched` means "phase 1 answered": the badge then reads the
            // server status, so a `resolve`/`none` row reads NO MATCH until
            // phase 2 moves it.
            state: server == null ? ('not_found' as const) : ('matched' as const),
            viewerHref: null,
          };
        });
        setMatching(false);
        // Hand the rows straight to phase 2 — it owns the setRows, so the
        // lines it is about to look up land already flipped to `resolving`.
        startResolve(built);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const throttled = axios.isAxiosError(err) && err.response?.status === 429;
        setMatchError(throttled ? MATCH_THROTTLED : MATCH_FAILED);
        setMatching(false);
      });

    return () => {
      cancelled = true;
      // A new parse invalidates the previous BOM's stream as surely as
      // leaving does — its events name row indices from a table that no
      // longer exists.
      resolveAbort.current?.abort();
    };
  }, [phase, parsed]);

  const handleParsed = useCallback((result: ParseResult, name: string, text: string) => {
    sourceText.current = text;
    setSourceName(name);

    // A hard error keeps the intake on screen with the reason attached; the
    // parser only sets it for the two unrecoverable cases (over the cap, or
    // nothing to read).
    if (result.error != null) {
      setParsed(result);
      setPhase('intake');
      return;
    }

    if (needsMapping(result)) {
      // A layout this browser has already been asked about is answered from
      // memory — the mapper is a question, and asking it twice about the same
      // weekly export is the thing the memory exists to prevent.
      const remembered = loadRoleMap(result.headerSignature);
      if (remembered != null && canPrice(remembered)) {
        const mapped = applyRoleMap(text, remembered);
        setParsed(mapped);
        setMapRoles(remembered);
        setPhase(mapped.error != null ? 'intake' : 'table');
        return;
      }
      setParsed(result);
      setMapRoles(result.roleByColumn);
      setPhase('mapping');
      return;
    }

    setParsed(result);
    setMapRoles(result.roleByColumn);
    setPhase('table');
  }, []);

  // Continue from the mapper: remember the answer against this header
  // signature, then re-materialize the SAME text with the chosen roles.
  const handleMapContinue = useCallback(() => {
    if (parsed == null) return;
    saveRoleMap(parsed.headerSignature, mapRoles);
    const mapped = applyRoleMap(sourceText.current, mapRoles);
    setParsed(mapped);
    setPhase(mapped.error != null ? 'intake' : 'table');
  }, [parsed, mapRoles]);

  const startOver = () => {
    resolveAbort.current?.abort();
    setParsed(null);
    sourceText.current = '';
    setSourceName(null);
    setMapRoles([]);
    setRows([]);
    setMatchError(null);
    setMatching(false);
    setResolveNote(null);
    setResolveError(null);
    setBuildQty(1);
    setIncludeDnp(false);
    setPhase('intake');
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <PageHead seo={isShare ? SHARE_SEO : STATIC_PAGE_SEO.bom} />
      <PageHeaderBand
        page="bom"
        title="BOM Pricing Tool"
        subtitle={
          <>
            Price every line of your build across <strong>dozens of distributors</strong>.
          </>
        }
      />

      {/* Surface wrapper INSIDE the motion div: the band above is a window
          onto the persistent BackdropLayer, so the wash starts here. */}
      <div className={styles.page}>
        <div className={styles.stack}>
          {isShare && shareState === 'loading' && (
            <p className={styles.phaseText} role="status">
              Loading this shared BOM&#8230;
            </p>
          )}

          {/* A dead link is NAMED, not silently redirected to the tool: the
              reader followed a URL somebody sent them and needs to know it is
              the link that expired, not their file that failed. */}
          {isShare && shareState === 'missing' && (
            <section className={styles.deadLink}>
              <h2 className={styles.phaseTitle}>This shared BOM is no longer available</h2>
              <p className={styles.phaseText}>
                Share links expire on their own, and the person who created this one may have let
                it lapse. Ask them for a fresh link, or price your own build in a minute.
              </p>
              <Link className={styles.deadCta} to="/bom">
                Start your own BOM &#8594;
              </Link>
            </section>
          )}

          {isShare && shareState === 'ready' && rows.length > 0 && (
            <section className={styles.tablePhase}>
              <p className={styles.shareBanner} role="status">
                Shared BOM
                {shareExpiry != null ? ` — expires ${formatShareDate(shareExpiry)}` : ''}
              </p>
              {/* Read-only: no intake above it, no share button below it, and
                  no live resolve behind it. Build quantity and the DNP toggle
                  stay live because both are arithmetic on data already on the
                  page — they ask nothing of anyone. */}
              <BomTable
                rows={rows}
                buildQty={buildQty}
                onBuildQtyChange={setBuildQty}
                onPickSimilar={null}
                includeDnp={includeDnp}
                onIncludeDnpChange={setIncludeDnp}
              />
            </section>
          )}

          {!isShare && phase === 'intake' && (
            <>
              <BomIntake onParsed={handleParsed} />
              {parsed?.error != null && (
                <p className={styles.pageError} role="alert">
                  {parsed.error}
                </p>
              )}
            </>
          )}

          {!isShare && phase === 'mapping' && parsed != null && (
            <ColumnMapper
              headers={parsed.headers}
              roles={mapRoles}
              text={sourceText.current}
              onChange={setMapRoles}
              onContinue={handleMapContinue}
            />
          )}

          {!isShare && phase === 'table' && parsed != null && (
            <section className={styles.tablePhase}>
              <div className={styles.bomHead}>
                <h2 className={styles.bomTitle}>Bill of Materials</h2>
                {sourceName != null && <span className={styles.bomFile}>{sourceName}</span>}
                <p className={styles.bomSub}>
                  {parsed.lines.length.toLocaleString('en-US')}{' '}
                  {parsed.lines.length === 1 ? 'line' : 'lines'} priced across{' '}
                  <strong>dozens of distributors</strong>. Your file stays in your browser.
                </p>
              </div>

              {parsed.warnings.map((warning) => (
                <p key={warning} className={styles.phaseWarn}>
                  {warning}
                </p>
              ))}

              {resolveNote != null && <p className={styles.phaseWarn}>{resolveNote}</p>}

              {matchError != null && (
                <p className={styles.pageError} role="alert">
                  {matchError}
                </p>
              )}

              {resolveError != null && (
                <p className={styles.phaseWarn} role="status">
                  {resolveError}
                </p>
              )}

              {matching && (
                <p className={styles.phaseText} role="status">
                  Pricing {parsed.lines.length.toLocaleString('en-US')}{' '}
                  {parsed.lines.length === 1 ? 'line' : 'lines'} against the catalog&#8230;
                </p>
              )}

              {!matching && rows.length > 0 && (
                <>
                  <BomTable
                    rows={rows}
                    buildQty={buildQty}
                    onBuildQtyChange={setBuildQty}
                    onPickSimilar={pickSimilar}
                    includeDnp={includeDnp}
                    onIncludeDnpChange={setIncludeDnp}
                  />
                  <ShareBar
                    rows={rows}
                    buildQty={buildQty}
                    includeDnp={includeDnp}
                    onChangeFile={startOver}
                  />
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </motion.div>
  );
}
