// "Find contacts" — who works at this lead's company, from Hunter, for the rep
// to REVIEW. Nothing is written by the search; a candidate reaches the roster
// only when the rep picks "Use for this lead" (the ordinary PATCH) or "Add as
// a lead" (the ordinary POST, with its identity rules and 409s).
//
// Hidden entirely when the server has no HUNTER_API_KEY: the status read 404s
// and the panel renders nothing (QuotePanel's posture for Stripe). The search
// itself is a click, never automatic — each one spends a Hunter credit (the
// server caches a domain's answer for a day, so a re-open is free).

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
  isThisLeadsContact,
  patternExample,
  readEnrichmentFailure,
  type EnrichmentFailure,
  type EnrichmentField,
} from './enrichment';
import pageStyles from './LeadDetail.module.scss';
import styles from './FindContacts.module.scss';

interface Props {
  lead: AdminLeadDetail;
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

type Phase = 'idle' | 'loading' | 'done' | 'failed';

export default function FindContacts({ lead, onApplied, onSessionExpired }: Props) {
  const consolePath = useConsolePath();
  const [configured, setConfigured] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
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

  // A refusal like "add its website first" is answered by editing the lead;
  // once any field the domain comes from changes, offer the search again.
  const domainInputs = [lead.website, lead.sales_email, lead.contact_email, lead.manufacturer_id]
    .map((v) => v ?? '')
    .join('|');
  useEffect(() => {
    setPhase((prev) => (prev === 'failed' ? 'idle' : prev));
    setFailure(null);
  }, [domainInputs]);

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

  const search = async () => {
    setPhase('loading');
    setFailure(null);
    setRows({});
    try {
      const found = await adminApi.getLeadEnrichment(lead.id);
      setResult(found);
      setPhase('done');
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 401 || status === 403) {
        const known = classifyLeadsError(err, '');
        if (known.kind === 'session') {
          onSessionExpired();
          return;
        }
      }
      setFailure(readEnrichmentFailure(status, axios.isAxiosError(err) ? err.response?.data : undefined));
      setPhase('failed');
    }
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
  const example = result ? patternExample(result.pattern, result.domain) : null;
  const sourceNote = result ? domainSourceNote(result.domain_source) : null;

  return (
    <section className={pageStyles.panel} aria-labelledby="find-contacts-title">
      <div className={pageStyles.panelHead}>
        <h2 className={pageStyles.panelTitle} id="find-contacts-title">
          Find contacts
        </h2>
        <span className={styles.attribution}>via Hunter</span>
      </div>
      <div className={pageStyles.panelBody}>
        {phase === 'idle' && (
          <div className={styles.intro}>
            <p className={styles.lede}>
              Look up people at this company and their work addresses. Nothing is saved until you
              choose someone.
            </p>
            <button
              type="button"
              className={`${pageStyles.btn} ${pageStyles.btnGhost}`}
              onClick={() => void search()}
            >
              Search Hunter
            </button>
          </div>
        )}

        <p className={styles.status} role="status" aria-live="polite">
          {phase === 'loading' ? 'Searching Hunter…' : ''}
        </p>

        {phase === 'failed' && failure && (
          <div className={styles.failure}>
            <p className={styles.failureText}>{failure.message}</p>
            {failure.retry && (
              <button
                type="button"
                className={`${pageStyles.btn} ${pageStyles.btnGhost}`}
                onClick={() => void search()}
              >
                Try again
              </button>
            )}
          </div>
        )}

        {phase === 'done' && result && (
          <>
            <p className={styles.summary}>
              <span>
                {people === 0
                  ? `Hunter has no one on file at ${result.domain}.`
                  : `${people} ${people === 1 ? 'address' : 'addresses'} at ${result.domain}`}
              </span>
              {sourceNote && <span className={styles.summaryNote}>{sourceNote}</span>}
              {example && <span className={styles.summaryNote}>usually {example}</span>}
            </p>

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
