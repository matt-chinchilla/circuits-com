// Sales codes — the rep's discount codes for Gold and Platinum on /join
// (spec §9, §12). Every code is created, switched off and extended here; a
// code is never deleted (its sales keep pointing at it). The server derives
// each code's status and builds its ready link from the code's own locks.
//
// Staff-only: the route table is also mounted under /account, so a customer
// who types the URL gets a notice, and the server refuses them anyway. A
// view-only account is refused the read (R6, 403 no_billing_access) and sees
// the quiet blocked state. Stripe unconfigured (404) reads as "not set up".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, X } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorCode, apiErrorDetail, isNoBillingAccess } from '@admin/services/apiError';
import { useAuth } from '@admin/contexts/AuthContext';
import { useConsolePath } from '@admin/services/consolePath';
import { copyText } from '@admin/services/clipboard';
import type { SalesCode, SalesCodeStatus } from '@admin/types/admin';
import CodeTicket from '../CodeTicket';
import NeedsAttention from '../NeedsAttention';
import {
  absoluteLink,
  codeStatusChip,
  expiresLabel,
  locksSummary,
  usesLabel,
} from '../salesCodes';
import styles from '../SalesCodes.module.scss';

type Filter = 'all' | SalesCodeStatus;
const FILTERS: Filter[] = ['all', 'live', 'used_up', 'expired', 'off'];

type LoadState = 'loading' | 'ready' | 'blocked' | 'unconfigured' | 'error';

function StaffSalesCodesPage() {
  const consolePath = useConsolePath();
  const { isReadOnly } = useAuth();
  const [codes, setCodes] = useState<SalesCode[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    adminApi
      .listSalesCodes()
      .then((rows) => {
        if (cancelled) return;
        setCodes(rows);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        if (isNoBillingAccess(err)) setState('blocked');
        else if (apiErrorCode(err).status === 404) setState('unconfigured');
        else setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(load, [load]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: codes.length };
    for (const c of codes) map[c.status] = (map[c.status] ?? 0) + 1;
    return map;
  }, [codes]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/-/g, '');
    return codes.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!q) return true;
      return [c.code, c.rep, c.supplier_name ?? '', c.category_name ?? '', c.email_lock ?? '', c.note ?? '']
        .join(' ')
        .toLowerCase()
        .replace(/-/g, '')
        .includes(q);
    });
  }, [codes, filter, search]);

  const copyLink = async (c: SalesCode) => {
    const ok = await copyText(absoluteLink(c.link, window.location.origin));
    setCopiedId(ok ? c.id : null);
    setNotice(ok ? null : 'Copy failed — select the link from the code’s row instead.');
  };

  const patch = async (
    c: SalesCode,
    body: { active?: boolean; expires_in_days?: number },
    done: (updated: SalesCode) => string,
  ) => {
    setRowBusy(c.id);
    setNotice(null);
    try {
      const updated = await adminApi.updateSalesCode(c.id, body);
      setCodes((rows) => rows.map((r) => (r.id === c.id ? updated : r)));
      setNotice(done(updated));
    } catch (err) {
      setNotice(apiErrorDetail(err) ?? 'That change did not save — try again.');
    } finally {
      setRowBusy(null);
    }
  };

  const filterLabel = (f: Filter) => (f === 'all' ? 'All' : codeStatusChip(f).label);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Sales codes</h1>
          <p className={styles.subtitle}>
            Discount codes for Gold and Platinum on /join. Each code takes an extra 1&ndash;15% of list off the
            Founder&rsquo;s Deal, never below 70% of list. Send the customer the code&rsquo;s link
            &mdash; it opens /join with the code and slot filled in.
          </p>
        </div>
        {!isReadOnly && state === 'ready' && (
          <Link to={consolePath('/admin/sales-codes/new')} className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={15} strokeWidth={2} />
            New code
          </Link>
        )}
      </header>

      {state === 'ready' && <NeedsAttention />}

      {state === 'blocked' || state === 'unconfigured' || state === 'error' ? (
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <p className={styles.quiet}>
              {state === 'blocked' &&
                'Sales codes are hidden from view-only accounts — they are live discounts on real money.'}
              {state === 'unconfigured' &&
                'Stripe billing is not set up in this environment, so there are no codes to sell with.'}
              {state === 'error' && 'The codes could not be loaded. Reload the page to try again.'}
            </p>
          </div>
        </div>
      ) : (
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.filterChip} ${filter === f ? styles.filterChipActive : ''}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {filterLabel(f)}
                <span className={styles.chipCount}>{counts[f] ?? 0}</span>
              </button>
            ))}
            <div className={styles.toolbarSpacer} />
            <div className={styles.inlineSearch}>
              <Search size={14} strokeWidth={2} />
              <input
                type="text"
                placeholder="Search code, rep, company or note…"
                aria-label="Search sales codes"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`}
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>

          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Works on</th>
                  <th>Uses</th>
                  <th>Rep</th>
                  <th>Expiry</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const chip = codeStatusChip(c.status);
                  const usable = c.status === 'live';
                  return (
                    <tr key={c.id}>
                      <td>
                        <CodeTicket display={c.display} points={c.code_points} dim={!usable} />
                        {c.note && <div className={styles.muted}>{c.note}</div>}
                      </td>
                      <td>
                        <div className={styles.locks}>
                          {locksSummary(c).map((lock) => (
                            <span key={lock} className={styles.lock}>
                              {lock}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {usesLabel(c)}
                        {c.sales.length > 0 && (
                          <ul className={styles.sales}>
                            {c.sales.map((s) => (
                              <li key={s.sponsor_id}>
                                <Link to={consolePath(`/admin/sponsors/${s.sponsor_id}/edit`)}>{s.company}</Link>
                                {` · $${s.price_usd.toLocaleString('en-US')}/mo`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{c.rep}</td>
                      <td className={styles.muted}>{expiresLabel(c.expires_at)}</td>
                      <td>
                        <span className={styles.statusChip} data-tone={chip.tone}>
                          {chip.label}
                        </span>
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          {usable && (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`}
                              onClick={() => copyLink(c)}
                            >
                              {copiedId === c.id ? 'Copied' : 'Copy link'}
                            </button>
                          )}
                          {!isReadOnly && c.status !== 'used_up' && (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`}
                              disabled={rowBusy === c.id}
                              onClick={() =>
                                patch(c, { expires_in_days: 14 }, (u) => `${u.display} now ${expiresLabel(u.expires_at).replace(/^Expires/, 'works until')}.`)
                              }
                            >
                              Extend 14 days
                            </button>
                          )}
                          {!isReadOnly && c.active && c.status !== 'used_up' && (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`}
                              disabled={rowBusy === c.id}
                              onClick={() => patch(c, { active: false }, (u) => `${u.display} is switched off.`)}
                            >
                              Switch off
                            </button>
                          )}
                          {!isReadOnly && !c.active && (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`}
                              disabled={rowBusy === c.id}
                              onClick={() => patch(c, { active: true }, (u) => `${u.display} is switched back on.`)}
                            >
                              Switch on
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className={styles.emptyRow}>
                      {state === 'loading'
                        ? 'Loading codes…'
                        : codes.length === 0
                          ? isReadOnly
                            ? 'No codes yet.'
                            : 'No codes yet. Create one with New code and send the customer its link.'
                          : 'No codes match the current filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerSalesCodesNotice() {
  return (
    <div className={styles.pageNarrow}>
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Sales codes are for the Circuit Center team</h2>
        </div>
        <div className={styles.panelBody}>
          <p className={styles.quiet}>
            If a rep sent you a code, open the link in their email &mdash; it takes you to the
            sponsorship page with the code already applied.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SalesCodesPage() {
  const { isCustomer } = useAuth();
  return isCustomer ? <CustomerSalesCodesNotice /> : <StaffSalesCodesPage />;
}
