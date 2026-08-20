// LeadsPanel — the dashboard's window onto the outreach checklist.
//
// ── Why this panel fetches for itself ──────────────────────────────────────
// Every other widget here is handed its data by the page shell's `Promise.all`.
// This one is not, for two reasons: the leads feed is the ONE payload the
// server refuses outright for the demo account (403 `demo_account_no_leads`),
// and it is the only one whose absence is a normal, expected state rather than
// a degraded one. Keeping the request — and its refusal — inside the panel
// means the shell never has to carry a "leads are blocked" flag through props.
// The effect uses the repo's canonical cancel flag so a late resolve cannot
// set state on an unmounted page.
//
// ── Demo mode ──────────────────────────────────────────────────────────────
// There is deliberately NO fabricated demo fixture: these are real people's
// real outcomes and a plausible-looking invention would be shown to prospects
// as if it were the business. Demo mode (and the server's 403, which a real
// admin never sees) both land on the same quiet body.
//
// ── Colour ─────────────────────────────────────────────────────────────────
// OUTCOME_META's hexes are DATA, so they arrive inline rather than as theme
// tokens. They are set as a SOLID fill with white type, never as coloured
// text: the three values are tuned for a light surface and would read ~1.5:1
// as a foreground on the dark admin theme, whereas white clears AA on all
// three either way. Every chip carries the glyph AND the word, so colour never
// carries the outcome alone (the CVD constraint recorded in outcome.ts).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { OUTCOME_META, firstInitial } from '@admin/pages/leads/outcome';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { RecentLeadContact } from '@admin/types/leads';
import { count } from './format';
import styles from '../DashboardPage.module.scss';

/** `admin_leads.DEMO_LEADS_FORBIDDEN_DETAIL`, matched verbatim so an ordinary
 *  permissions 403 can never be mistaken for the demo read-refusal. */
const DEMO_LEADS_DETAIL = 'demo_account_no_leads';

/** One request. 100 is the endpoint's own ceiling (`min(limit, 100)`). */
const FETCH_LIMIT = 100;

/** Rows shown before "See More" expands the panel in place. */
const PREVIEW_ROWS = 10;

const DEMO_NOTICE = 'Not available in demo.';
const BLOCKED_NOTICE = "Recent contacts aren't available right now.";

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * `2026-08-20T14:02:11+00:00` -> `3h ago`.
 *
 * Local to this panel on purpose: `./format.ts` carries no relative-time
 * helper today and is outside this change's file set — hoist this there the
 * moment a second widget needs it.
 *
 * The zone guard is load-bearing. `LeadContact.created_at` is
 * `DateTime(timezone=True)`, which Postgres serializes with an offset, but a
 * naive stamp (SQLite, or any row written without one) is parsed by
 * `Date.parse` as LOCAL time — which would print hours of drift for a call
 * logged seconds ago. Absent a zone the value is UTC by contract, so say so.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(parsed)) return '';
  // Clamps a future stamp (clock skew between the box and the browser) to
  // "just now" rather than printing a negative age.
  const secs = Math.round((now - parsed) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

interface LeadsPanelProps {
  demoMode: boolean;
}

export default function LeadsPanel({ demoMode }: LeadsPanelProps) {
  const [contacts, setContacts] = useState<RecentLeadContact[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(!demoMode);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (demoMode) {
      setContacts([]);
      setNotice(DEMO_NOTICE);
      setLoading(false);
      setExpanded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    adminApi
      .getRecentLeadContacts(FETCH_LIMIT)
      .then((res) => {
        if (cancelled) return;
        setContacts(res.contacts ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setContacts([]);
        // The demo refusal is an expected state, not a failure — it gets the
        // same quiet body as demo mode, never an error surface.
        setNotice(apiErrorDetail(err) === DEMO_LEADS_DETAIL ? DEMO_NOTICE : BLOCKED_NOTICE);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demoMode]);

  // The endpoint already orders `created_at DESC` and caps at 100, so the head
  // of the list is the newest and the count is a floor, not a total — the chip
  // says `100+` at the ceiling rather than claiming exactly a hundred.
  const visible = expanded ? contacts : contacts.slice(0, PREVIEW_ROWS);
  const canExpand = contacts.length > PREVIEW_ROWS;
  const chipCount =
    contacts.length >= FETCH_LIMIT ? `${count(FETCH_LIMIT)}+` : count(contacts.length);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Leads</h3>
          <p className={styles.panelSub}>Latest contact attempts</p>
        </div>
        {contacts.length > 0 && <span className={styles.leadsChip}>{chipCount} recent</span>}
      </div>

      {loading ? (
        <div className={styles.empty}>Checking recent contacts&hellip;</div>
      ) : notice ? (
        <div className={styles.empty}>{notice}</div>
      ) : contacts.length === 0 ? (
        <div className={styles.empty}>
          No calls logged yet &mdash; the checklist is waiting.{' '}
          <Link to="/admin/leads" className={styles.panelLink}>
            Open Leads
          </Link>
        </div>
      ) : (
        <>
          <div className={`${styles.leadsList} ${expanded ? styles.leadsScroll : ''}`}>
            {visible.map((c) => {
              const meta = OUTCOME_META[c.outcome];
              // Company-only rows (no named contact) get a centred dot, never a
              // fake initial — see firstInitial()'s note.
              const initial = firstInitial(c.contact_name);
              const target = c.contact_name ?? c.company_name ?? 'Unnamed lead';
              const company = c.company_name && c.company_name !== target ? c.company_name : null;
              return (
                <Link
                  key={c.id}
                  to={`/admin/leads/${encodeURIComponent(c.lead_id)}`}
                  className={styles.leadsRow}
                >
                  <span
                    className={styles.leadsDisc}
                    style={{ background: meta.hex }}
                    aria-hidden="true"
                  >
                    {initial ?? '·'}
                  </span>
                  <span className={styles.leadsMain}>
                    <span className={styles.leadsWho}>
                      {c.recorded_by ? (
                        <>
                          <span className={styles.leadsRep}>{c.recorded_by}</span> &rarr;{' '}
                        </>
                      ) : null}
                      {target}
                    </span>
                    {company ? <span className={styles.leadsCompany}>{company}</span> : null}
                  </span>
                  <span className={styles.leadsTags}>
                    <span className={styles.leadsOutcome} style={{ background: meta.hex }}>
                      <span aria-hidden="true">{meta.glyph}</span> {meta.word}
                    </span>
                    {c.sale_tier ? <span className={styles.leadsTier}>{c.sale_tier}</span> : null}
                  </span>
                  <span className={styles.leadsTime}>{relativeTime(c.created_at)}</span>
                </Link>
              );
            })}
          </div>
          {canExpand && (
            <div className={styles.leadsMore}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                {expanded ? 'Show fewer' : 'See More'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
