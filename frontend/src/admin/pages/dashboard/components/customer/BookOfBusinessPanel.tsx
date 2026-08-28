// BookOfBusinessPanel — who this company actually does business with.
//
// The staff board's arena with one hub instead of several: their company at
// the centre, every counterparty on a computed ring around it, bubble AREA by
// how many of their parts that counterparty accounts for. Same treatment for
// the same reasons — `layout: 'none'` over computed geometry (a force
// simulation cannot hold an even angular division), `roam: 'scale'` so the
// graph zooms but can never be dragged out of its bordered box.
//
// The counterparties are DERIVED from the catalog joins, not from any CRM
// table: a distributor's are the makers on its shelf, a maker's are the
// distributors stocking it. An account holding both links gets both kinds in
// one graph, which is why the key counts them separately rather than titling
// the panel after one of them.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { CHART_SERIES } from '@admin/components/charts/chartTheme';
import type { AccountBookNode, AccountBookOfBusiness } from '@admin/types/account';
import { count } from '../format';
import { BOOK_MAX_NODES } from './bookLayout';
import { bookGraphOption } from './chartOptions';
import styles from '../../DashboardPage.module.scss';
import own from './CustomerPanels.module.scss';

const CENTER_COLOR = CHART_SERIES[0];
const KIND_COLOR: Record<AccountBookNode['kind'], string> = {
  manufacturer: CHART_SERIES[3],
  supplier: CHART_SERIES[1],
};
const KIND_LABEL: Record<AccountBookNode['kind'], string> = {
  manufacturer: 'Manufacturers you carry',
  supplier: 'Distributors stocking you',
};

// A module-level function, not an arrow rebuilt per render: the option builder
// takes it as input, and a fresh identity would rebuild the option (and redraw
// the whole graph) on every parent render.
function colorFor(kind: AccountBookNode['kind']): string {
  return KIND_COLOR[kind];
}

interface BookOfBusinessPanelProps {
  book: AccountBookOfBusiness | null;
  loading: boolean;
}

export default function BookOfBusinessPanel({ book, loading }: BookOfBusinessPanelProps) {
  // Biggest counterparties first, then trimmed: past three rings the labels
  // collide whatever the geometry does, so the panel draws the top ones and
  // says how many it left out rather than drawing an unreadable disc.
  const ranked = useMemo(() => {
    const all = [...(book?.nodes ?? [])].sort(
      (a, b) => (Number(b.parts_count) || 0) - (Number(a.parts_count) || 0),
    );
    return { all, shown: all.slice(0, BOOK_MAX_NODES) };
  }, [book]);

  const centerName = book?.center.name ?? 'Your company';

  const option = useMemo(
    () =>
      bookGraphOption({
        centerName,
        nodes: ranked.shown,
        colorFor,
        centerColor: CENTER_COLOR,
        valueFormat: count,
      }),
    [centerName, ranked],
  );

  const kinds = useMemo(() => {
    const tally: Record<AccountBookNode['kind'], number> = { manufacturer: 0, supplier: 0 };
    for (const node of ranked.all) tally[node.kind] += 1;
    return tally;
  }, [ranked]);

  const hidden = ranked.all.length - ranked.shown.length;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Book of business</h3>
          <p className={styles.panelSub}>
            Your counterparties &middot; bubble size = parts in common &middot; scroll to
            zoom
          </p>
        </div>
      </div>
      <div className={styles.panelBody}>
        {ranked.all.length === 0 ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading counterparties…'
            ) : (
              <>
                <strong>No counterparties yet.</strong>
                <span>
                  This graph is drawn from your catalog: the makers you carry, and the
                  distributors stocking what you make.
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <div className={styles.bookChart}>
              <EChart option={option} style={{ height: 420 }} />
            </div>
            <ul className={own.kindKey}>
              <li className={own.kindKeyRow}>
                <span
                  className={own.kindKeyDot}
                  style={{ background: CENTER_COLOR }}
                  aria-hidden="true"
                />
                {centerName}
              </li>
              {(Object.keys(KIND_LABEL) as AccountBookNode['kind'][]).map((kind) => (
                <li key={kind} className={own.kindKeyRow}>
                  <span
                    className={own.kindKeyDot}
                    style={{ background: KIND_COLOR[kind] }}
                    aria-hidden="true"
                  />
                  {KIND_LABEL[kind]}
                  <span className={own.kindKeyCount}>{count(kinds[kind])}</span>
                </li>
              ))}
              {hidden > 0 && (
                <li className={own.kindKeyRow}>
                  {count(hidden)} smaller {hidden === 1 ? 'counterparty' : 'counterparties'}{' '}
                  not drawn
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
