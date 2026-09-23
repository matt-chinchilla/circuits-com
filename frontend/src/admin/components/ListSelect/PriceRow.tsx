// One row of a price dropdown: dollars first in tabular figures, a hairline,
// then the discount — "$8,000 | 5%" (owner, 2026-09-23). A code that fits
// either tier shows both prices, tagged with the element symbols /join uses
// for the tiers (Au, Pt). The 0% row is the Founder's Deal, in the founder
// band's gold.

import { money, percentLabel, type PriceRowModel, type PriceTier } from './priceRows';
import styles from './ListSelect.module.scss';

const ELEMENT: Record<PriceTier, { symbol: string; name: string }> = {
  gold: { symbol: 'Au', name: 'Gold' },
  platinum: { symbol: 'Pt', name: 'Platinum' },
};

export default function PriceRow({ row }: { row: PriceRowModel }) {
  const dual = row.prices.length > 1;
  return (
    <span className={styles.priceRow}>
      <span className={styles.prices} data-dual={dual || undefined}>
        {row.prices.length === 0 ? (
          <span className={styles.pricePending}>&mdash;</span>
        ) : (
          row.prices.map((p) => (
            <span key={p.tier ?? 'one'} className={styles.price}>
              {dual && p.tier && (
                <abbr className={styles.element} data-tier={p.tier} title={ELEMENT[p.tier].name}>
                  {ELEMENT[p.tier].symbol}
                </abbr>
              )}
              <span className={styles.dollars}>{money(p.usd)}</span>
            </span>
          ))
        )}
        {!dual && row.prices.length === 1 && <span className={styles.per}>/mo</span>}
      </span>
      <span className={styles.rule} aria-hidden="true" />
      <span className={styles.pct} data-founder={row.value === 0 || undefined}>
        {percentLabel(row.value)}
      </span>
      {(row.capped || row.current) && (
        <span className={styles.tags}>
          {row.capped && <span className={styles.tag}>30% cap</span>}
          {row.current && (
            <span className={styles.tag} data-current>
              current
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** A plain row with a quiet trailing note — "Daniel · you", "14 days · until Oct 7". */
export function TextRow({ main, note }: { main: string; note?: string }) {
  return (
    <span className={styles.textRow}>
      <span className={styles.textMain}>{main}</span>
      {note && <span className={styles.textNote}>{note}</span>}
    </span>
  );
}
