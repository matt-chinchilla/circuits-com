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

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { classifyLeadsError } from '@admin/pages/leads/loadError';
import { OUTCOME_META, firstInitial } from '@admin/pages/leads/outcome';
import { relativeTime } from '@admin/pages/leads/time';
import { adminApi } from '@admin/services/adminApi';
import { useCachedQuery } from '@admin/services/queryCache';
import type { RecentLeadContact } from '@admin/types/leads';
import { count } from './format';
import styles from '../DashboardPage.module.scss';

/** `admin_leads.DEMO_LEADS_FORBIDDEN_DETAIL`, matched verbatim so an ordinary
 *  permissions 403 can never be mistaken for the demo read-refusal. */
/** One request. 100 is the endpoint's own ceiling (`min(limit, 100)`). */
const FETCH_LIMIT = 100;

/** Rows shown before "See More" expands the panel in place. */
const PREVIEW_ROWS = 10;

/** Initial fetch: one row beyond the preview — enough to know whether See
 *  More exists at a tenth of the payload; the 100-row fetch happens lazily on
 *  first expand (the rare path pays, not every dashboard visit). */
const INITIAL_LIMIT = PREVIEW_ROWS + 1;

const DEMO_NOTICE = 'Not available for this account.';
const BLOCKED_NOTICE = "Recent contacts aren't available right now.";
const EMPTY_CONTACTS: RecentLeadContact[] = [];


interface LeadsPanelProps {
  demoMode: boolean;
}

export default function LeadsPanel({ demoMode }: LeadsPanelProps) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  // A null key in demo mode is the "don't fetch" branch: nothing is requested
  // and the panel shows the demo notice. Otherwise the preview window comes
  // from the query cache like the rest of the dashboard.
  const query = useCachedQuery(demoMode ? null : 'dashboard:leadContacts', () =>
    adminApi.getRecentLeadContacts(INITIAL_LIMIT),
  );
  // The first expand upgrades to the full window; it lives beside the cached
  // preview rather than inside it so the cache never holds a page-sized list.
  const [fullContacts, setFullContacts] = useState<RecentLeadContact[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const contacts: RecentLeadContact[] = fullContacts ?? query.data?.contacts ?? EMPTY_CONTACTS;
  const loading = !demoMode && query.loading;
  // The access refusal is an expected state, not a failure — it gets the same
  // quiet body as demo mode, never an error surface. Classified on the RAW
  // detail: string-comparing the translated channel would break the day the
  // code lands in CODE_MESSAGES.
  const notice: string | null = demoMode
    ? DEMO_NOTICE
    : query.error !== undefined
      ? classifyLeadsError(query.error, BLOCKED_NOTICE).kind === 'demo'
        ? DEMO_NOTICE
        : BLOCKED_NOTICE
      : null;

  // The endpoint already orders `created_at DESC` and caps at 100, so the head
  // of the list is the newest and the count is a floor, not a total — the chip
  // says `100+` at the ceiling rather than claiming exactly a hundred.
  const visible = expanded ? contacts : contacts.slice(0, PREVIEW_ROWS);
  const canExpand = contacts.length > PREVIEW_ROWS;

  const expandFull = () => {
    setExpanded((v) => !v);
    // First expand upgrades to the full window; later toggles reuse it.
    if (!expanded && contacts.length <= INITIAL_LIMIT) {
      adminApi
        .getRecentLeadContacts(FETCH_LIMIT)
        .then((res) => setFullContacts(res.contacts ?? []))
        .catch(() => {});
    }
  };
  const chipCount =
    contacts.length >= FETCH_LIMIT
      ? `${count(FETCH_LIMIT)}+`
      : !expanded && contacts.length > PREVIEW_ROWS
        ? `${count(PREVIEW_ROWS)}+`
        : count(contacts.length);

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
          <Link to={consolePath('/admin/leads')} className={styles.panelLink}>
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
                  to={consolePath(`/admin/leads/${encodeURIComponent(c.lead_id)}`)}
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
                onClick={expandFull}
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
