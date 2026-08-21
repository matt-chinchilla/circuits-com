import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { priceAt, recommend, tierRankFromOffers } from '../lib/priceBreaks';
import type { BomOffer, TableRow } from '../lib/types';
import CoverageStrip, { type CoverageCounts } from './CoverageStrip';
import MatchBadge from './MatchBadge';
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

interface BomTableProps {
  rows: TableRow[];
  buildQty: number;
  onBuildQtyChange: (qty: number) => void;
}

interface RowView {
  row: TableRow;
  /** bom_qty × build_qty — the number every price on this row is read at. */
  lineQty: number;
  offers: BomOffer[];
  chosen: BomOffer | null;
  unitPrice: number | null;
  extPrice: number | null;
  /** DNP lines are shown, greyed, and kept out of every total (spec §5). */
  excluded: boolean;
}

function formatUnit(price: number): string {
  return price < 1 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`;
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  if (chosen == null) {
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

export default function BomTable({ rows, buildQty, onBuildQtyChange }: BomTableProps) {
  const views: RowView[] = useMemo(
    () =>
      rows.map((row) => {
        const lineQty = Math.max(1, row.qty) * Math.max(1, buildQty);
        const offers = row.server?.offers ?? [];
        let chosen: BomOffer | null = null;
        if (offers.length > 0) {
          // The mirrored home doing its job: same rule the server ran, re-run
          // at the real line quantity.
          const pick = recommend(offers, lineQty, tierRankFromOffers(offers));
          chosen = pick == null ? null : offers.find((o) => o.supplier_id === pick) ?? null;
        }
        const unitPrice = chosen == null ? null : priceAt(chosen, lineQty);
        return {
          row,
          lineQty,
          offers,
          chosen,
          unitPrice,
          extPrice: unitPrice == null ? null : unitPrice * lineQty,
          excluded: row.dnp,
        };
      }),
    [rows, buildQty],
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

  const dnpCount = views.length - counted.length;

  return (
    <div className={styles.wrap}>
      <CoverageStrip counts={counts} buildQty={buildQty} onBuildQtyChange={onBuildQtyChange} />

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={`${styles.th} ${styles.thNum}`} scope="col">
                #
              </th>
              <th className={styles.th} scope="col">
                Part
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
              const { row, lineQty, offers, chosen, unitPrice, extPrice, excluded } = view;
              const part = row.server?.part ?? null;
              const rail = lifecycleRail(row);
              const avail = availabilityRail(view);
              const identity = part?.sku ?? row.mpn ?? row.value ?? '—';
              const maker = part?.manufacturer_name ?? row.manufacturer;
              const description = part?.description ?? row.description;
              const overflow = row.refs.length - MAX_REF_CHIPS;

              return (
                <tr
                  key={row.index}
                  className={excluded ? `${styles.row} ${styles.rowDnp}` : styles.row}
                >
                  <td className={`${styles.td} ${styles.tdNum}`}>{row.index}</td>

                  <td className={styles.td}>
                    <div className={styles.partCell}>
                      <span
                        className={`${styles.rail} ${rail.className}`}
                        role="img"
                        aria-label={rail.label}
                        title={rail.label}
                      />
                      <div className={styles.partBody}>
                        <span className={styles.sku}>{identity}</span>
                        {maker != null && <span className={styles.maker}>{maker}</span>}
                        <div className={styles.badgeRow}>
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
                          {excluded && <span className={styles.dnpChip}>DNP</span>}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className={`${styles.td} ${styles.tdDesc}`}>
                    <span className={styles.desc}>{description ?? '—'}</span>
                    {row.server?.package_warning != null && (
                      <span className={styles.packageWarn}>{row.server.package_warning}</span>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRight}`}>
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

                  <td className={styles.td}>
                    {chosen == null ? (
                      <span className={styles.muted}>—</span>
                    ) : (
                      <div className={styles.supplierCell}>
                        <div className={styles.supplierBody}>
                          <span className={styles.supplierName}>{chosen.supplier_name}</span>
                          <span className={styles.supplierMeta}>
                            {chosen.stock_quantity.toLocaleString('en-US')} in stock
                            {chosen.price_stale ? ' · price is stale' : ''}
                          </span>
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

                  <td className={`${styles.td} ${styles.tdRight}`}>
                    {unitPrice == null || extPrice == null ? (
                      <span className={styles.muted}>—</span>
                    ) : (
                      <>
                        <span className={styles.unit}>{formatUnit(unitPrice)}</span>
                        <span className={styles.ext}>{formatMoney(extPrice)}</span>
                      </>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdRight}`}>
                    {offers.length > 1 ? (
                      <span className={styles.muted}>
                        {offers.length.toLocaleString('en-US')} offers
                      </span>
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
          {dnpCount > 0
            ? `, and ${dnpCount.toLocaleString('en-US')} DNP ${dnpCount === 1 ? 'line is' : 'lines are'} excluded`
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
