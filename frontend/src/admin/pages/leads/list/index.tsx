// Leads — the CALL CHECKLIST.
//
// This is the internal outreach roster (real people, real phone numbers), which
// is why `GET /admin/leads/` refuses the demo account on READS as well as
// writes: `POST /api/auth/demo` hands a real session to any anonymous visitor,
// so a read-open list would publish the sales roster. The 403 detail is
// `demo_account_no_leads` and this page answers it with a quiet panel rather
// than an error — a prospect clicking around should see a closed door, not a
// stack trace. (CatalogSwitch hides its Leads half for demo sessions too, so
// reaching this page at all takes a typed URL.)
//
// SERVER-side filtering, sorting and paging (the endpoint takes
// page/per_page/q/outcome/tier/needs_enrichment/sort/desc), so every control
// below maps to a query parameter and the client never holds the full set. The
// page number lives in `?p=N` so a lead opened from page 4 comes back to
// page 4 — the same contract the public category page uses.
//
// THE INTERACTION is the disc in column one: click it, pick an outcome, and the
// row re-renders from the detail the server sends back. Re-contact is allowed
// (history is append-only), so a filled disc re-opens the same menu.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, X } from 'lucide-react';

import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import type { AdminLead, AdminLeadDetail, LeadListResponse, LeadOutcome } from '@admin/types/leads';

import CatalogSwitch from '../../manufacturers/CatalogSwitch';
import ColumnHeader, { type SortDir } from '../../manufacturers/ColumnHeader';
import { classifyLeadsError, SESSION_EXPIRED_MESSAGE } from '../loadError';
import { OUTCOME_META, OUTCOME_ORDER, outcomeInkVars } from '../outcome';
import OutcomeDisc from '../OutcomeDisc';
import OutcomeMenu from '../OutcomeMenu';
import styles from './LeadsPage.module.scss';

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_ROWS = 8;

// Server sort keys — `_SORTS` in routes/admin_leads.py. Anything else silently
// falls back to company_name server-side, so this union IS the contract.
type SortKey = 'company' | 'contact' | 'tier' | 'ring' | 'outcome' | 'contacted';

// 'none' is the server's sentinel for "never contacted" (last_outcome IS NULL)
// — a real filter value, not an absent parameter.
type OutcomeFilter = 'all' | LeadOutcome | 'none';

type TierFilter = 'all' | 'S' | 'M' | 'L';

const TIER_CHOICES: ReadonlyArray<{ key: TierFilter; label: string }> = [
  { key: 'all', label: 'All sizes' },
  { key: 'S', label: 'S' },
  { key: 'M', label: 'M' },
  { key: 'L', label: 'L' },
];

// ─── Cell formatters ────────────────────────────────────────────────────────

function locationLabel(lead: AdminLead): string | null {
  const parts = [lead.city, lead.state].filter((p): p is string => !!p && !!p.trim());
  return parts.length ? parts.join(', ') : null;
}

/**
 * Parse a server timestamp defensively.
 *
 * The columns are `DateTime(timezone=True)`, so Postgres round-trips an offset
 * and `isoformat()` emits `+00:00`. A naive value (possible on SQLite, which
 * these tables also run on) would have NO offset, and JS would then read it as
 * LOCAL time — silently shifting every "3h ago" by the viewer's offset. Treat
 * an offset-less string as UTC, which is what the writer meant.
 */
function parseServerTime(iso: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return new Date(hasZone ? iso : `${iso}Z`).getTime();
}

/** Coarse relative age — a call list cares about "this week" vs "in March". */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = parseServerTime(iso);
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function LeadsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Number(searchParams.get('p') ?? '1');
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;

  const [data, setData] = useState<LeadListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoBlocked, setDemoBlocked] = useState(false);
  // A 401 — the token the console is still rendering behind has been retired.
  // Held separately from `error` because it is not a message to read past, it
  // is a state to recover from.
  const [sessionExpired, setSessionExpired] = useState(false);
  // Bumped by the Retry button; only a fetch dependency.
  const [reloadNonce, setReloadNonce] = useState(0);
  const { logout } = useAuth();

  // What the admin types vs. what reaches the server. One request per keystroke
  // over a 359-row roster is a self-inflicted DoS.
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [enrichOnly, setEnrichOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  // The open outcome popover. The ANCHOR ELEMENT is held (not a rect) so the
  // menu's outside-click guard can exclude the disc that opened it — otherwise
  // mousedown-to-close fires before the disc's onClick and the menu toggles
  // itself back open forever.
  const [menu, setMenu] = useState<{ lead: AdminLead; anchor: HTMLElement } | null>(null);

  // Fetch. Cancel-flagged so a slow page-2 response can't overwrite the page-3
  // rows the admin has already moved on to.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string | number | boolean> = {
      page,
      per_page: PER_PAGE,
      sort: sortKey ?? 'company',
      desc: sortDir === 'desc',
    };
    if (q) params.q = q;
    if (outcomeFilter !== 'all') params.outcome = outcomeFilter;
    if (tierFilter !== 'all') params.tier = tierFilter;
    if (enrichOnly) params.needs_enrichment = true;

    adminApi
      .getLeads(params)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError('');
        setDemoBlocked(false);
        setSessionExpired(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const failure = classifyLeadsError(err, 'Could not load the call list.');
        setData(null);
        setDemoBlocked(failure.kind === 'demo');
        setSessionExpired(failure.kind === 'session');
        setError(failure.kind === 'failed' ? failure.message : '');
        if (failure.kind === 'failed') console.error('[LeadsPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, q, outcomeFilter, tierFilter, enrichOnly, sortKey, sortDir, reloadNonce]);

  // RECOVERY, not just a message. The adminApi interceptor already dropped the
  // dead token, but `AuthContext.user` is React state no 401 ever cleared — so
  // `isAuthenticated` stayed true and ProtectedRoute kept rendering a console
  // for a session that no longer exists. `logout()` clears that state and the
  // route bounces to the sign-in screen. It must go through logout() and not a
  // navigate(): LoginPage sends an authenticated visitor back to /admin, so a
  // route push while `user` is still set would ping-pong.
  useEffect(() => {
    if (!sessionExpired) return;
    if (localStorage.getItem('admin_token') === null) logout();
  }, [sessionExpired, logout]);

  // Changing what the list CONTAINS invalidates the page number. Deliberately
  // NOT depending on `setSearchParams` — its identity changes on every URL
  // change, so this effect would also fire on page change and pin the list to
  // page 1 forever; the functional form needs no setter dep. First run is
  // skipped so a deep link like `?p=4` survives mount.
  const filtersKey = `${q}|${outcomeFilter}|${tierFilter}|${enrichOnly}|${sortKey}|${sortDir}`;
  const firstFiltersRun = useRef(true);
  useEffect(() => {
    if (firstFiltersRun.current) {
      firstFiltersRun.current = false;
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('p');
        return next;
      },
      { replace: true },
    );
  }, [filtersKey]);

  const goToPage = (next: number) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next <= 1) params.delete('p');
      else params.set('p', String(next));
      return params;
    });
    window.scrollTo({ top: 0, left: 0 });
  };

  const rows: AdminLead[] = data?.leads ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const rangeEnd = Math.min(page * PER_PAGE, total);

  const handleSort = (key: SortKey, dir: SortDir) => {
    if (dir === null) {
      setSortKey(null);
      setSortDir(null);
      return;
    }
    setSortKey(key);
    setSortDir(dir);
  };

  // Patch the row in place from the detail the write returned. The row is left
  // VISIBLE even when it no longer matches the active filter (recording an
  // outcome while filtered to Uncontacted): the rep needs to see that the call
  // landed, and the next fetch reconciles. `total` goes momentarily stale,
  // which is the cheaper of the two lies.
  const applyRecorded = (detail: AdminLeadDetail) => {
    setData((prev) =>
      prev
        ? { ...prev, leads: prev.leads.map((l) => (l.id === detail.id ? { ...l, ...detail } : l)) }
        : prev,
    );
  };

  const skeletonRows = useMemo(() => Array.from({ length: SKELETON_ROWS }, (_, i) => i), []);

  const filtersActive = !!q || outcomeFilter !== 'all' || tierFilter !== 'all' || enrichOnly;

  const head = (
    <header className={styles.pageHead}>
      <div className={styles.pageHeadLeft}>
        <h1 className={styles.title}>Leads</h1>
        <p className={styles.subtitle}>
          The outreach call list &mdash; internal only, never a public surface.
        </p>
      </div>
      <CatalogSwitch />
      <div className={styles.pageHeadActions}>
        <span className={styles.countPill}>
          {total.toLocaleString('en-US')} {total === 1 ? 'lead' : 'leads'}
        </span>
      </div>
    </header>
  );

  // The dead-session screen. The effect above is already signing the retired
  // token out, so in practice this paints for a frame before ProtectedRoute
  // redirects — the button is the manual door for the case where the token is
  // somehow still in storage.
  if (sessionExpired) {
    return (
      <div className={styles.page}>
        {head}
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Signed out</p>
            <p className={styles.blockedBody}>{SESSION_EXPIRED_MESSAGE}</p>
            <button type="button" className={styles.recoverBtn} onClick={logout}>
              Sign in again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (demoBlocked) {
    return (
      <div className={styles.page}>
        {head}
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Not available in demo</p>
            <p className={styles.blockedBody}>
              The lead roster holds real contact details for real people, so the demo account is
              refused at the API &mdash; on reads as well as edits. Sign in with a staff account to
              work the call list.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {head}

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.chipGroup} role="group" aria-label="Filter by outcome">
            <button
              type="button"
              className={`${styles.filterChip} ${outcomeFilter === 'all' ? styles.filterChipActive : ''}`}
              aria-pressed={outcomeFilter === 'all'}
              onClick={() => setOutcomeFilter('all')}
            >
              All
            </button>
            {OUTCOME_ORDER.map((key) => {
              const meta = OUTCOME_META[key];
              const active = outcomeFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                  style={active ? outcomeInkVars(meta) : undefined}
                  aria-pressed={active}
                  onClick={() => setOutcomeFilter(key)}
                >
                  <span aria-hidden="true">
                    {meta.glyph}
                  </span>
                  {meta.word}
                </button>
              );
            })}
            <button
              type="button"
              className={`${styles.filterChip} ${outcomeFilter === 'none' ? styles.filterChipActive : ''}`}
              aria-pressed={outcomeFilter === 'none'}
              onClick={() => setOutcomeFilter('none')}
            >
              Uncontacted
            </button>
          </div>

          <div className={styles.chipGroup} role="group" aria-label="Filter by company size">
            {TIER_CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`${styles.filterChip} ${tierFilter === c.key ? styles.filterChipActive : ''}`}
                aria-pressed={tierFilter === c.key}
                onClick={() => setTierFilter(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`${styles.filterChip} ${enrichOnly ? styles.filterChipActive : ''}`}
            aria-pressed={enrichOnly}
            onClick={() => setEnrichOnly((v) => !v)}
          >
            Needs enrichment
          </button>

          <div className={styles.toolbarSpacer} />

          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search company, contact, city, notes..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search leads"
            />
            {searchInput && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearchInput('')}
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        {error && (
          // A load failure used to render as "No rows / 0 leads", which is what
          // let a populated roster read as an empty one. It gets its own panel,
          // above the table, with the way out.
          <div className={styles.loadErrorBar} role="alert">
            <span className={styles.loadErrorText}>{error}</span>
            <button
              type="button"
              className={styles.recoverBtn}
              onClick={() => setReloadNonce((n) => n + 1)}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.discHead}>
                  <span className={styles.srOnly}>Call outcome</span>
                </th>
                <ColumnHeader
                  kind="sort-only"
                  label="Contact"
                  colKey="contact"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="Company"
                  colKey="company"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="Tier"
                  colKey="tier"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'L → S', desc: 'S → L' }}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="Ring"
                  colKey="ring"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Nearest first', desc: 'Furthest first' }}
                />
                <th>Location</th>
                <ColumnHeader
                  kind="sort-only"
                  label="Last outcome"
                  colKey="outcome"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                />
                <th className={styles.numHead}>Attempts</th>
                <ColumnHeader
                  kind="sort-only"
                  label="When"
                  colKey="contacted"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Oldest first', desc: 'Newest first' }}
                />
              </tr>
            </thead>
            <tbody>
              {loading &&
                skeletonRows.map((i) => (
                  <tr key={`skel-${i}`} className={styles.skelRow} aria-hidden="true">
                    <td>
                      <span className={`${styles.skel} ${styles.skelDisc}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelWide}`} />
                      <span className={`${styles.skel} ${styles.skelSub}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelChip}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelNum}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelNum}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelNum}`} />
                    </td>
                  </tr>
                ))}

              {!loading &&
                rows.map((lead) => {
                  const meta = lead.last_outcome ? OUTCOME_META[lead.last_outcome] : null;
                  const place = locationLabel(lead);
                  const when = relativeTime(lead.last_contacted_at);
                  const discLabel = lead.contact_name ?? lead.company_name;
                  return (
                    <tr
                      key={lead.id}
                      className={styles.row}
                      onClick={(e) => {
                        // The disc is a button and the contact name is a link;
                        // neither should also trigger the row navigation.
                        if (e.target instanceof Element && e.target.closest('a,button')) return;
                        navigate(`/admin/leads/${lead.id}`);
                      }}
                    >
                      <td className={styles.discCell}>
                        <button
                          type="button"
                          className={styles.discBtn}
                          aria-haspopup="dialog"
                          aria-expanded={menu?.lead.id === lead.id}
                          aria-label={
                            meta
                              ? `${meta.word} — record another outcome for ${discLabel}`
                              : `Record a call outcome for ${discLabel}`
                          }
                          onClick={(e) => {
                            const anchor = e.currentTarget;
                            // Clicking the OPEN row's disc closes it (the menu's
                            // own outside-click guard skips the anchor).
                            setMenu((prev) =>
                              prev?.lead.id === lead.id ? null : { lead, anchor },
                            );
                          }}
                        >
                          <OutcomeDisc
                            outcome={lead.last_outcome}
                            contactName={lead.contact_name}
                          />
                        </button>
                      </td>

                      <td>
                        <Link to={`/admin/leads/${lead.id}`} className={styles.contactLink}>
                          {lead.contact_name ? (
                            <>
                              <span className={styles.contactName}>{lead.contact_name}</span>
                              {lead.contact_title && (
                                <span className={styles.contactTitle}>{lead.contact_title}</span>
                              )}
                            </>
                          ) : (
                            // No person on file yet: the COMPANY carries the row.
                            <span className={styles.contactCompany}>{lead.company_name}</span>
                          )}
                        </Link>
                        {lead.needs_enrichment && (
                          <span className={styles.enrichChip}>needs enrichment</span>
                        )}
                      </td>

                      <td>
                        <span className={styles.companyName}>{lead.company_name}</span>
                        {lead.branch_label && (
                          <span className={styles.branchChip}>{lead.branch_label}</span>
                        )}
                      </td>

                      <td>
                        {lead.tier ? (
                          <span className={styles.tierChip}>{lead.tier}</span>
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>

                      <td className={styles.numCell}>
                        {lead.ring ? (
                          lead.ring === 'UNVERIFIED' ? (
                            <span className={styles.ringUnverified}>unverified</span>
                          ) : (
                            lead.ring
                          )
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>

                      <td>
                        {place ?? <span className={styles.muted}>&mdash;</span>}
                      </td>

                      <td>
                        {meta ? (
                          // Word AND glyph, never colour alone (the CVD rule
                          // recorded in outcome.ts).
                          <span className={styles.outcomeText} style={outcomeInkVars(meta)}>
                            <span aria-hidden="true">{meta.glyph}</span>
                            {meta.word}
                          </span>
                        ) : (
                          <span className={styles.muted}>Uncontacted</span>
                        )}
                      </td>

                      <td className={styles.numCell}>
                        {lead.contact_attempts > 0 ? (
                          lead.contact_attempts
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>

                      <td className={styles.whenCell}>
                        {when ?? <span className={styles.muted}>&mdash;</span>}
                      </td>
                    </tr>
                  );
                })}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className={styles.emptyRow}>
                    {error
                      ? 'The list could not be loaded.'
                      : filtersActive
                        ? 'No leads match the current filters.'
                        : 'No leads yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={styles.pagination}>
          <span className={styles.pageInfo}>
            {total === 0
              ? 'No rows'
              : `${rangeStart.toLocaleString('en-US')}–${rangeEnd.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
          </span>
          <div className={styles.pageControls}>
            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || loading}
            >
              &larr; Previous
            </button>
            <span className={styles.pageOf}>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages || loading}
            >
              Next &rarr;
            </button>
          </div>
        </div>
      </div>

      {menu && (
        <OutcomeMenu
          // Keyed on the lead so moving from one disc to another REMOUNTS the
          // popover. Without it, a batched close+open would reuse the instance
          // and carry the previous lead's picked outcome and typed note over.
          key={menu.lead.id}
          leadId={menu.lead.id}
          anchor={menu.anchor}
          label={menu.lead.contact_name ?? menu.lead.company_name}
          onRecorded={applyRecorded}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
