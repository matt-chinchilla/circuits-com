import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { priceAt, recommend, tierRankFromOffers } from '../lib/priceBreaks';
import { formatMoney, formatUnit } from '../lib/format';
import type { BomOffer, TableRow } from '../lib/types';
import AlternatesDropdown from './AlternatesDropdown';
import CoverageStrip, { type CoverageCounts } from './CoverageStrip';
import MatchBadge from './MatchBadge';
import SimilarDropdown from './SimilarDropdown';
import styles from './BomTable.module.scss';

/**
 * The priced BOM.
 *
 * Two things make this table different from the catalog's PartsTable:
 *
 * 1. Every price on screen is computed HERE, from the break tables the match
 *    response already carried. Quantities never reach the server (D7), so the
 *    server could only pick at the ladder's base qty; changing the build
 *    quantity re-runs the identical rule client-side against data we already
 *    hold. That is what `lib/priceBreaks.ts` exists for — no refetch.
 * 2. Each row carries two channel rails: lifecycle on the left, availability
 *    on the right. They are informational, and they are allowed to say "we
 *    do not know" — an unverified lifecycle renders hatched rather than
 *    borrowing the enum's default and claiming the part is Active (D6).
 */

/** Designators past this collapse into a `+N` — a 200-ref line is legal
 *  (JLCPCB's own cap) and would otherwise own the whole row. */
const MAX_REF_CHIPS = 6;

/** A quote request carries the LINE, not the BOM (D7 in spirit), and it goes
 *  into a URL — so it is clamped rather than trusted to be short. */
const QUOTE_IDENTITY_MAX = 180;

/** "Resistor_SMD:R_0805_2012Metric" → "R_0805_2012Metric" — the readable
 *  half of a KiCad LIB:FOOTPRINT value, for no-MPN submitted lines. */
function footprintHint(footprint: string): string {
  const idx = footprint.indexOf(':');
  return idx >= 0 ? footprint.slice(idx + 1) : footprint;
}

interface BomTableProps {
  rows: TableRow[];
  buildQty: number;
  onBuildQtyChange: (qty: number) => void;
  /** The Matches column's "Similar" pick — the page re-matches the line by
   *  the chosen SKU (identity only travels, per D7). Null in the read-only
   *  share view: that table asks nothing of anyone, so the menu renders as a
   *  plain badge there. */
  onPickSimilar: ((index: number, sku: string) => void) | null;
  /** DNP lines counted, priced and totalled like any other line. Default off:
   *  the whole point of the flag is that nobody is buying those parts. */
  includeDnp: boolean;
  onIncludeDnpChange: (include: boolean) => void;
}

interface RowView {
  row: TableRow;
  /** bom_qty × build_qty — the number every price on this row is read at. */
  lineQty: number;
  offers: BomOffer[];
  /** What `recommend()` picked, before any reader override. */
  recommendedId: string | null;
  /** What the row is actually priced at: the pin if there is one, else above. */
  chosen: BomOffer | null;
  unitPrice: number | null;
  extPrice: number | null;
  /** DNP lines are shown, greyed, and kept out of every total (spec §5). */
  excluded: boolean;
}

/**
 * What the Recommended column says when there is no offer to put there.
 *
 * Phase 2's outcomes are stated in WORDS here, not only as a badge tooltip: a
 * row that is mid-lookup, a row a distributor had never heard of, and a row we
 * ran out of daily lookups for are three different facts, and only the first
 * of them is going to change while the reader watches. Everything except the
 * first also earns a "Request a quote" link, because a line with no price and
 * nothing else coming needs a next step, not an em dash.
 */
function emptyRecommendation(view: RowView): string {
  switch (view.row.state) {
    case 'resolving':
      return 'Looking this part up live…';
    case 'unavailable':
      return 'Live lookups are exhausted for today — request a quote instead.';
    case 'not_found':
      return 'No distributor result — request a quote.';
    default:
      // A catalog hit whose listings are all empty is a different fact from no
      // catalog hit at all, and the buyer's next move differs too.
      return view.offers.length > 0
        ? 'No distributor has it in stock — request a quote.'
        : 'No catalog match — request a quote.';
  }
}

/**
 * The identity of ONE line, for the partner desk.
 *
 * Quantities and designators are deliberately absent: a quote request is a
 * question about a part, and the rest of the BOM is nobody's business but the
 * reader's (D7). What the desk needs is enough to look the part up.
 */
function quoteIdentity(row: TableRow): string {
  const part = row.server?.part ?? null;
  const candidates = [
    part?.sku ?? row.mpn,
    part?.manufacturer_name ?? row.manufacturer,
    row.value,
    row.footprint,
    part?.description ?? row.description,
  ];
  const seen: string[] = [];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const trimmed = candidate.trim();
    if (trimmed === '' || seen.includes(trimmed)) continue;
    seen.push(trimmed);
  }
  return seen.join(' · ').slice(0, QUOTE_IDENTITY_MAX);
}

/** The partner desk, pre-aimed at this one line. `#partner-desk` is the id the
 *  contact form carries; the page scrolls itself there on arrival. */
function quoteHref(row: TableRow): string {
  return `/contact?part=${encodeURIComponent(quoteIdentity(row))}#partner-desk`;
}

/** What the left rail claims about the part's life. `lifecycle_verified` is
 *  the truth-bit: false means a feed never confirmed anything, whatever the
 *  enum column happens to hold, so it outranks the enum entirely. */
function lifecycleRail(row: TableRow): { className: string; label: string } {
  const part = row.server?.part ?? null;
  if (part == null || !part.lifecycle_verified) {
    return { className: styles.railUnverified, label: 'Lifecycle: unverified' };
  }
  switch (part.lifecycle_status) {
    case 'active':
      return { className: styles.railActive, label: 'Lifecycle: active' };
    case 'nrnd':
      return { className: styles.railNrnd, label: 'Lifecycle: not recommended for new designs' };
    case 'obsolete':
      return { className: styles.railEol, label: 'Lifecycle: obsolete' };
    default:
      return { className: styles.railUnverified, label: 'Lifecycle: unknown' };
  }
}

/** What the right rail claims about getting the part. Staleness beats the
 *  stock colours: a price nobody has refreshed in a month is the more useful
 *  warning than "enough in stock" (spec §5). */
function availabilityRail(view: RowView): { className: string; label: string } {
  const { chosen, lineQty } = view;
  // A pinned offer can be one with nothing on the shelf — the reader is
  // allowed to price against their own distributor either way, but the rail
  // has to say red, not "only 0 of 40 in stock" in the partial violet.
  if (chosen == null || chosen.stock_quantity <= 0) {
    return { className: styles.availNone, label: 'Availability: nothing in stock' };
  }
  if (chosen.price_stale) {
    return { className: styles.availStale, label: 'Availability: price not refreshed in 30 days' };
  }
  if (chosen.stock_quantity >= lineQty) {
    return { className: styles.availFull, label: `Availability: ${chosen.stock_quantity} in stock` };
  }
  return {
    className: styles.availPartial,
    label: `Availability: only ${chosen.stock_quantity} of ${lineQty} in stock`,
  };
}

export default function BomTable({
  rows,
  buildQty,
  onBuildQtyChange,
  onPickSimilar,
  includeDnp,
  onIncludeDnpChange,
}: BomTableProps) {
  // Reader overrides of `recommend()`, keyed by line index. Client-only and
  // deliberately un-persisted — it is a what-if, not a decision. A pin whose
  // supplier is absent from a later BOM's offers simply fails to resolve and
  // the row falls back to the recommendation, so nothing has to clear it.
  const [pins, setPins] = useState<Record<number, string>>({});

  const views: RowView[] = useMemo(
    () =>
      rows.map((row) => {
        const lineQty = Math.max(1, row.qty) * Math.max(1, buildQty);
        const offers = row.server?.offers ?? [];
        let recommendedId: string | null = null;
        if (offers.length > 0) {
          // The mirrored home doing its job: same rule the server ran, re-run
          // at the real line quantity.
          recommendedId = recommend(offers, lineQty, tierRankFromOffers(offers));
        }
        const recommendedOffer =
          recommendedId == null
            ? null
            : offers.find((o) => o.supplier_id === recommendedId) ?? null;
        const pin = pins[row.index];
        const pinnedOffer = pin == null ? null : offers.find((o) => o.supplier_id === pin) ?? null;
        const chosen = pinnedOffer ?? recommendedOffer;
        const unitPrice = chosen == null ? null : priceAt(chosen, lineQty);
        return {
          row,
          lineQty,
          offers,
          recommendedId,
          chosen,
          unitPrice,
          extPrice: unitPrice == null ? null : unitPrice * lineQty,
          excluded: row.dnp && !includeDnp,
        };
      }),
    [rows, buildQty, includeDnp, pins],
  );

  const counted = useMemo(() => views.filter((v) => !v.excluded), [views]);

  const counts: CoverageCounts = useMemo(() => {
    let exact = 0;
    let approx = 0;
    let live = 0;
    let resolving = 0;
    let priced = 0;
    for (const view of counted) {
      const status = view.row.server?.status ?? null;
      if (view.row.state === 'resolving') resolving += 1;
      else if (status === 'exact') exact += 1;
      else if (status === 'approx') approx += 1;
      else if (status === 'exact_live') live += 1;
      if (view.unitPrice != null) priced += 1;
    }
    return {
      total: counted.length,
      priced,
      exact,
      approx,
      live,
      // Everything that is neither a match nor still in flight. Derived, not
      // counted separately, so the four chips can never sum to a lie.
      notFound: counted.length - exact - approx - live - resolving,
    };
  }, [counted]);

  const totalExt = useMemo(
    () => counted.reduce((sum, v) => sum + (v.extPrice ?? 0), 0),
    [counted],
  );

  const dnpCount = useMemo(() => views.filter((v) => v.row.dnp).length, [views]);
  const excludedCount = views.length - counted.length;

  return (
    <div className={styles.wrap}>
      <CoverageStrip
        counts={counts}
        buildQty={buildQty}
        onBuildQtyChange={onBuildQtyChange}
        dnpCount={dnpCount}
        includeDnp={includeDnp}
        onIncludeDnpChange={onIncludeDnpChange}
      />

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={`${styles.th} ${styles.thNum}`} scope="col">
                #
              </th>
              <th className={`${styles.th} ${styles.thSub}`} scope="col">
                Submitted part
              </th>
              <th className={styles.th} scope="col">
                Matched part
              </th>
              <th className={`${styles.th} ${styles.thMatch}`} scope="col">
                Matches
              </th>
              <th className={`${styles.th} ${styles.thDesc}`} scope="col">
                Description
              </th>
              <th className={`${styles.th} ${styles.thRight}`} scope="col">
                Qty
              </th>
              <th className={`${styles.th} ${styles.thRefs}`} scope="col">
                Designators
              </th>
              <th className={styles.th} scope="col">
                Recommended
              </th>
              <th className={`${styles.th} ${styles.thRight}`} scope="col">
                Unit / Ext
              </th>
              <th className={`${styles.th} ${styles.thRight}`} scope="col">
                Alternates
              </th>
            </tr>
          </thead>

          <tbody>
            {views.map((view) => {
              const { row, lineQty, offers, recommendedId, chosen, unitPrice, extPrice, excluded } =
                view;
              const part = row.server?.part ?? null;
              const rail = lifecycleRail(row);
              const avail = availabilityRail(view);
              const identity = part?.sku ?? row.mpn ?? row.value ?? '—';
              const submitted = row.mpn ?? row.value ?? '—';
              const maker = part?.manufacturer_name ?? row.manufacturer;
              const description = part?.description ?? row.description;
              const overflow = row.refs.length - MAX_REF_CHIPS;
              // Nothing to price and nothing still in flight: the row's next
              // step is a human, so offer one.
              const wantsQuote = chosen == null && row.state !== 'resolving';

              return (
                <tr
                  key={row.index}
                  className={[
                    styles.row,
                    excluded ? styles.rowDnp : '',
                    // A live lookup takes hundreds of milliseconds per line
                    // and they land one at a time; the row says so while it
                    // waits rather than sitting on a stale NO MATCH.
                    row.state === 'resolving' ? styles.rowResolving : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-busy={row.state === 'resolving' || undefined}
                >
                  <td className={`${styles.td} ${styles.tdNum}`}>{row.index}</td>

                  <td className={`${styles.td} ${styles.tdSub}`}>
                    <span className={styles.subSku}>{submitted}</span>
                    {row.mpn == null && row.footprint != null && (
                      <span className={styles.subHint}>{footprintHint(row.footprint)}</span>
                    )}
                    {/* The chip marks the line as DNP whether or not it is
                        being counted — the fact belongs to the SUBMITTED BOM,
                        the greying belongs to the toggle. */}
                    {row.dnp && <span className={styles.dnpChip}>DNP</span>}
                  </td>

                  <td className={`${styles.td} ${styles.tdPart}`}>
                    <div className={styles.partCell}>
                      <span
                        className={`${styles.rail} ${rail.className}`}
                        role="img"
                        aria-label={rail.label}
                        title={rail.label}
                      />
                      <div className={styles.partBody}>
                        <span className={part != null ? styles.sku : styles.muted}>
                          {part?.sku ?? '—'}
                        </span>
                        {maker != null && <span className={styles.maker}>{maker}</span>}
                      </div>
                    </div>
                  </td>

                  <td className={`${styles.td} ${styles.tdMatch}`}>
                    {row.server?.status === 'approx' &&
                    row.server.similar.length > 0 &&
                    onPickSimilar != null ? (
                      <SimilarDropdown
                        options={row.server.similar}
                        matchedSku={part?.sku ?? null}
                        reason={row.server.approx_reason}
                        partLabel={submitted}
                        onPick={(sku) => onPickSimilar(row.index, sku)}
                      />
                    ) : (
                      <MatchBadge
                        status={row.server?.status ?? null}
                        state={row.state}
                        approxReason={row.server?.approx_reason ?? null}
                        detail={
                          row.state === 'unavailable'
                            ? 'Live lookups are exhausted for today'
                            : null
                        }
                      />
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdDesc}`}>
                    <span className={styles.desc}>{description ?? '—'}</span>
                    {row.server?.package_warning != null && (
                      <span className={styles.packageWarn}>{row.server.package_warning}</span>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRight} ${styles.tdQty}`}>
                    <span className={styles.qtyBig}>{lineQty.toLocaleString('en-US')}</span>
                    {buildQty > 1 && (
                      <span className={styles.qtyMath}>
                        {row.qty.toLocaleString('en-US')} &#215; {buildQty.toLocaleString('en-US')}
                      </span>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRefs}`}>
                    {row.refs.length === 0 ? (
                      <span className={styles.muted}>—</span>
                    ) : (
                      <span className={styles.chips}>
                        {row.refs.slice(0, MAX_REF_CHIPS).map((ref) =>
                          // The §7.6 viewer seam: a text chip today, a jump
                          // into the schematic the day viewerHref is a route.
                          row.viewerHref != null ? (
                            <Link key={ref} className={styles.refChip} to={row.viewerHref}>
                              {ref}
                            </Link>
                          ) : (
                            <span key={ref} className={styles.refChip}>
                              {ref}
                            </span>
                          ),
                        )}
                        {overflow > 0 && (
                          <span
                            className={styles.refMore}
                            title={row.refs.join(', ')}
                          >{`+${overflow}`}</span>
                        )}
                      </span>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRec}`}>
                    {chosen == null ? (
                      <>
                        <span className={styles.stateNote}>{emptyRecommendation(view)}</span>
                        {wantsQuote && (
                          <Link className={styles.quoteLink} to={quoteHref(row)}>
                            Request a quote &#8594;
                          </Link>
                        )}
                      </>
                    ) : (
                      <div className={styles.supplierCell}>
                        <div className={styles.supplierBody}>
                          <span className={styles.supplierName}>{chosen.supplier_name}</span>
                          <span className={styles.supplierMeta}>
                            {chosen.stock_quantity.toLocaleString('en-US')} in stock
                            {chosen.price_stale ? ' · price is stale' : ''}
                          </span>
                          {/* Say it out loud when the total is no longer our
                              recommendation — a silently overridden row is a
                              number the reader cannot account for later. */}
                          {chosen.supplier_id !== recommendedId && (
                            <span className={styles.pinnedNote}>your pick</span>
                          )}
                        </div>
                        {chosen.tier != null && (
                          <span className={styles.tierBadge} data-tier={chosen.tier}>
                            {chosen.tier}
                          </span>
                        )}
                        <span
                          className={`${styles.rail} ${avail.className}`}
                          role="img"
                          aria-label={avail.label}
                          title={avail.label}
                        />
                      </div>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRight} ${styles.tdPrice}`}>
                    {unitPrice == null || extPrice == null ? (
                      <span className={styles.muted}>—</span>
                    ) : (
                      <>
                        <span className={styles.unit}>{formatUnit(unitPrice)}</span>
                        <span className={styles.ext}>{formatMoney(extPrice)}</span>
                      </>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRight} ${styles.tdAlt}`}>
                    {offers.length > 0 ? (
                      <AlternatesDropdown
                        offers={offers}
                        lineQty={lineQty}
                        chosenSupplierId={chosen?.supplier_id ?? null}
                        recommendedSupplierId={recommendedId}
                        partLabel={identity}
                        onPick={(supplierId) =>
                          setPins((prev) => {
                            const next = { ...prev };
                            if (supplierId == null) delete next[row.index];
                            else next[row.index] = supplierId;
                            return next;
                          })
                        }
                      />
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.totals}>
        <p className={styles.totalsNote}>
          Totals cover the {counts.priced.toLocaleString('en-US')} priced{' '}
          {counts.priced === 1 ? 'line' : 'lines'}
          {counts.priced < counts.total
            ? ` — ${(counts.total - counts.priced).toLocaleString('en-US')} still unpriced`
            : ''}
          {excludedCount > 0
            ? `, and ${excludedCount.toLocaleString('en-US')} DNP ${excludedCount === 1 ? 'line is' : 'lines are'} excluded`
            : ''}
          .
        </p>
        <p className={styles.totalsValue}>
          <span className={styles.totalsLabel}>Build total</span>
          <span className={styles.totalsAmount}>{formatMoney(totalExt)}</span>
        </p>
      </div>
    </div>
  );
}
