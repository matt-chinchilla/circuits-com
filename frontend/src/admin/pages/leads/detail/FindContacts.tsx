// "Find contacts" — who works at this lead's company, from Hunter, for the rep
// to REVIEW. A candidate reaches the roster only when the rep picks "Use for
// this lead" (the ordinary PATCH) or "Add as a lead" (the ordinary POST, with
// its identity rules and 409s).
//
// Each company is searched ONCE (owner, 2026-09-25: "prevent people from
// searching companies that have already been searched for"). The panel opens
// on the STORED answer (GET, which never calls Hunter); the Search button
// appears only while the server reports something still `pending`, and the
// server refuses a repeat search on its own — the missing button is a
// courtesy, not the block. A branch row of an already-searched company opens
// straight onto its results with "Searched <date> by <name>".
//
// Hidden entirely when the server has no HUNTER_API_KEY: the status read 404s
// and the panel renders nothing (QuotePanel's posture for Stripe).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorCode } from '@admin/services/apiError';
import { useConsolePath } from '@admin/services/consolePath';
import type {
  AdminLeadDetail,
  EnrichmentCandidate,
  LeadEnrichment,
  LeadExistsDetail,
} from '@admin/types/leads';
import { safeHttpUrl } from '@shared/utils/url';

import { classifyLeadsError } from '../loadError';
import { leadLabel, readLeadExists } from '../new/leadForm';
import {
  confidenceLabel,
  domainSourceNote,
  enrichmentCreateBody,
  enrichmentPatch,
  enrichmentView,
  isThisLeadsContact,
  patternExample,
  readEnrichmentFailure,
  searchedNote,
  type EnrichmentFailure,
  type EnrichmentField,
} from './enrichment';
import pageStyles from './LeadDetail.module.scss';
import styles from './FindContacts.module.scss';

interface Props {
  lead: AdminLeadDetail;
  /** The signed-in username — "Searched … by you". */
  viewer?: string | null;
  /** A candidate was written onto this lead; `fields` are the ones it filled. */
  onApplied: (detail: AdminLeadDetail, fields: EnrichmentField[]) => void;
  onSessionExpired: () => void;
}

interface RowState {
  busy?: 'use' | 'add';
  added?: { id: string };
  exists?: LeadExistsDetail;
  error?: string;
}

// loading = reading the stored answer (free); searching = a POST in flight.
type Phase = 'loading' | 'ready' | 'searching' | 'failed';

export default function FindContacts({ lead, viewer, onApplied, onSessionExpired }: Props) {
  const consolePath = useConsolePath();
  const [configured, setConfigured] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [failedAction, setFailedAction] = useState<'load' | 'search'>('load');
  const [reloads, setReloads] = useState(0);
  const [result, setResult] = useState<LeadEnrichment | null>(null);
  const [failure, setFailure] = useState<EnrichmentFailure | null>(null);
  // Keyed by address — the one field every candidate has.
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let cancelled = false;
    adminApi
      .getLeadEnrichmentStatus()
      .then(() => {
        if (!cancelled) setConfigured(true);
      })
      .catch(() => {
        // 404 = no key on this server; anything else — hide rather than
        // offer a button that cannot work.
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (err: unknown, action: 'load' | 'search') => {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 401 || status === 403) {
      const known = classifyLeadsError(err, '');
      if (known.kind === 'session') {
        onSessionExpired();
        return;
      }
    }
    setFailure(readEnrichmentFailure(status, axios.isAxiosError(err) ? err.response?.data : undefined));
    setFailedAction(action);
    setPhase('failed');
  };

  // The stored answer — free, so it is read on open. Read again when a field
  // the search depends on changes: a refusal like "add its website first" is
  // answered by editing the lead, and a new contact name may need its own
  // lookup.
  const searchInputs = [
    lead.website,
    lead.sales_email,
    lead.contact_email,
    lead.contact_name,
    lead.manufacturer_id,
  ]
    .map((v) => v ?? '')
    .join('|');
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    setFailure(null);
    // A re-read after an edit keeps the list on screen until the answer lands.
    setPhase((prev) => (prev === 'ready' ? prev : 'loading'));
    adminApi
      .getLeadEnrichment(lead.id)
      .then((found) => {
        if (cancelled) return;
        setResult(found);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult(null);
        fail(err, 'load');
      });
    return () => {
      cancelled = true;
    };
    // `fail` is left out on purpose: it is recreated each render and reads
    // only props, so depending on its identity would re-read every render.
  }, [configured, lead.id, searchInputs, reloads]);

  if (!configured) return null;

  const setRow = (email: string, next: RowState) =>
    setRows((prev) => ({ ...prev, [email]: next }));

  // After a write, the candidate IS on the list now — say so, and stop
  // offering the action that just ran.
  const markOnList = (email: string, leadId: string) =>
    setResult((prev) =>
      prev
        ? {
            ...prev,
            candidates: prev.candidates.map((c) =>
              c.email === email ? { ...c, existing_lead_id: leadId } : c,
            ),
            contact_email_suggestion:
              prev.contact_email_suggestion?.email === email
                ? { ...prev.contact_email_suggestion, existing_lead_id: leadId }
                : prev.contact_email_suggestion,
          }
        : prev,
    );

  // The only call that spends a credit — and the server spends it only on
  // what is not stored yet.
  const search = async () => {
    setPhase('searching');
    setFailure(null);
    setRows({});
    try {
      const found = await adminApi.searchLeadEnrichment(lead.id);
      setResult(found);
      setPhase('ready');
    } catch (err) {
      fail(err, 'search');
    }
  };

  const retry = () => {
    if (failedAction === 'search') void search();
    else setReloads((n) => n + 1);
  };

  const failMessage = (err: unknown, fallback: string): string => {
    const { code } = apiErrorCode(err);
    if (code === 'read_only') return 'This account is view-only.';
    const known = classifyLeadsError(err, fallback);
    if (known.kind === 'session') onSessionExpired();
    return known.message || fallback;
  };

  const use = async (c: EnrichmentCandidate) => {
    const patch = enrichmentPatch(c, lead);
    if (!patch) return;
    setRow(c.email, { busy: 'use' });
    try {
      const updated = (await adminApi.updateLead(lead.id, patch)) as AdminLeadDetail;
      onApplied(updated, Object.keys(patch) as EnrichmentField[]);
      markOnList(c.email, lead.id);
      setRow(c.email, {});
    } catch (err) {
      setRow(c.email, { error: failMessage(err, 'That was not saved. Try again.') });
    }
  };

  const add = async (c: EnrichmentCandidate) => {
    const body = enrichmentCreateBody(c, lead);
    if (!body) return;
    setRow(c.email, { busy: 'add' });
    try {
      const created = await adminApi.createLead(body);
      setRow(c.email, { added: { id: created.id } });
      markOnList(c.email, created.id);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const exists = readLeadExists(status, axios.isAxiosError(err) ? err.response?.data : undefined);
      if (exists) {
        setRow(c.email, { exists });
        return;
      }
      setRow(c.email, { error: failMessage(err, 'The lead was not added. Try again.') });
    }
  };

  function actions(c: EnrichmentCandidate) {
    const row = rows[c.email] ?? {};
    if (row.added) {
      return (
        <Link to={consolePath(`/admin/leads/${row.added.id}`)} className={styles.state}>
          Added &middot; open
        </Link>
      );
    }
    if (row.exists) {
      return row.exists.code === 'lead_exists' ? (
        <Link to={consolePath(`/admin/leads/${row.exists.lead_id}`)} className={styles.state}>
          {leadLabel(row.exists.contact_name, row.exists.company_name)} is already on the list
        </Link>
      ) : (
        <span className={styles.stateMuted}>Already on a list</span>
      );
    }
    if (c.existing_lead_id === lead.id) return <span className={styles.stateMuted}>This lead</span>;
    const canUse = enrichmentPatch(c, lead) !== null;
    const canAdd = c.full_name != null && !isThisLeadsContact(c, lead) && !c.existing_lead_id;
    return (
      <>
        {c.existing_lead_id && (
          <Link to={consolePath(`/admin/leads/${c.existing_lead_id}`)} className={styles.state}>
            On the list
          </Link>
        )}
        {canUse && (
          <button
            type="button"
            className={`${pageStyles.btn} ${pageStyles.btnPrimary} ${styles.actionBtn}`}
            disabled={row.busy != null}
            onClick={() => void use(c)}
          >
            {row.busy === 'use' ? 'Saving…' : 'Use for this lead'}
          </button>
        )}
        {canAdd && (
          <button
            type="button"
            className={`${pageStyles.btn} ${pageStyles.btnGhost} ${styles.actionBtn}`}
            disabled={row.busy != null}
            onClick={() => void add(c)}
          >
            {row.busy === 'add' ? 'Adding…' : 'Add as a lead'}
          </button>
        )}
      </>
    );
  }

  function candidateRow(c: EnrichmentCandidate) {
    const linkedin = safeHttpUrl(c.linkedin_url);
    const trust = confidenceLabel(c);
    const error = rows[c.email]?.error;
    return (
      <li key={c.email} className={styles.row}>
        <div className={styles.who}>
          <span className={c.full_name ? styles.name : styles.nameGeneric}>
            {c.full_name ?? 'Company address'}
          </span>
          {c.position && <span className={styles.position}>{c.position}</span>}
        </div>
        <div className={styles.reach}>
          <span className={styles.emailLine}>
            <a className={pageStyles.link} href={`mailto:${c.email}`}>
              {c.email}
            </a>
            {trust && <span className={styles.trust}>{trust}</span>}
          </span>
          {(c.phone || linkedin) && (
            <span className={styles.extra}>
              {c.phone && (
                <a className={pageStyles.link} href={`tel:${c.phone}`}>
                  {c.phone}
                </a>
              )}
              {linkedin && (
                <a className={pageStyles.link} href={linkedin} target="_blank" rel="noopener noreferrer">
                  LinkedIn
                </a>
              )}
            </span>
          )}
        </div>
        <div className={styles.actions}>{actions(c)}</div>
        {error && (
          <p className={styles.rowError} role="alert">
            {error}
          </p>
        )}
      </li>
    );
  }

  const suggestion = result?.contact_email_suggestion ?? null;
  const people = result?.candidates.length ?? 0;
  const view = result ? enrichmentView(result, lead.contact_name) : null;
  const showResults = result != null && view?.showResults === true && phase !== 'loading';
  // The spend button: only while something is pending, and not beside a
  // failure that has its own "Try again".
  const searchLabel = phase === 'ready' || phase === 'searching' ? (view?.searchLabel ?? null) : null;
  const example = result ? patternExample(result.pattern, result.domain) : null;
  const sourceNote = result ? domainSourceNote(result.domain_source) : null;
  const searched = result ? searchedNote(result, viewer) : null;

  const searchButton = searchLabel && (
    <button
      type="button"
      className={`${pageStyles.btn} ${pageStyles.btnGhost}`}
      disabled={phase === 'searching'}
      onClick={() => void search()}
    >
      {searchLabel}
    </button>
  );

  return (
    <section className={pageStyles.panel} aria-labelledby="find-contacts-title">
      <div className={pageStyles.panelHead}>
        <h2 className={pageStyles.panelTitle} id="find-contacts-title">
          Find contacts
        </h2>
        <span className={styles.attribution}>via Hunter</span>
      </div>
      <div className={pageStyles.panelBody}>
        {searchButton && !showResults && (
          <div className={styles.intro}>
            <p className={styles.lede}>
              Look up people at this company and their work addresses. A company is searched once
              and the answer is kept for everyone; nothing on this lead changes until you choose
              someone.
            </p>
            {searchButton}
          </div>
        )}

        <p className={styles.status} role="status" aria-live="polite">
          {phase === 'searching' ? 'Searching Hunter…' : ''}
        </p>

        {phase === 'failed' && failure && (
          <div className={styles.failure}>
            <p className={styles.failureText}>{failure.message}</p>
            {failure.retry && (
              <button
                type="button"
                className={`${pageStyles.btn} ${pageStyles.btnGhost}`}
                onClick={retry}
              >
                Try again
              </button>
            )}
          </div>
        )}

        {showResults && result && (
          <>
            <p className={styles.summary}>
              <span>
                {people === 0
                  ? `Hunter has no one on file at ${result.domain}.`
                  : `${people} ${people === 1 ? 'address' : 'addresses'} at ${result.domain}`}
              </span>
              {sourceNote && <span className={styles.summaryNote}>{sourceNote}</span>}
              {example && <span className={styles.summaryNote}>usually {example}</span>}
              {searched && (
                <span className={styles.summaryNote} data-searched-note="">
                  {searched}
                </span>
              )}
            </p>

            {searchButton && (
              <div className={styles.intro}>
                <p className={styles.lede}>
                  {lead.contact_name ?? 'This contact'}&rsquo;s own address has not been looked up.
                </p>
                {searchButton}
              </div>
            )}

            {suggestion && (
              <div className={styles.suggestion}>
                <p className={styles.suggestionHead}>
                  Likely address for {lead.contact_name ?? 'this contact'}
                </p>
                <ul className={styles.list}>{candidateRow(suggestion)}</ul>
              </div>
            )}
            {result.suggestion_error && (
              <p className={styles.summaryNote}>
                Could not look up {lead.contact_name}&rsquo;s own address: {result.suggestion_error}
              </p>
            )}

            {people > 0 && <ul className={styles.list}>{result.candidates.map(candidateRow)}</ul>}
          </>
        )}
      </div>
    </section>
  );
}
