// Lead profile — everything known about one company/contact, plus the
// append-only record of every call made to them.
//
// Demo is refused here for the same reason as the list (`demo_account_no_leads`
// on READS, not just writes): this page renders a real person's direct line and
// personal email.
//
// Three things this page deliberately does NOT do:
//   1. It never creates a sponsorship. `sale_tier` on a converted call is a
//      LABEL (services/leads.py) — the "Start a quote" button navigates to the
//      sponsors desk and stops there, which is why it says so out loud.
//   2. It never deletes history. `lead_contacts` is append-only server-side, so
//      the timeline has no row actions.
//   3. It never renders a contact field it doesn't have. Absent is absent.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pencil, X } from 'lucide-react';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import type { AdminLeadDetail } from '@admin/types/leads';
import { safeHttpUrl } from '@shared/utils/url';

import { classifyLeadsError, SESSION_EXPIRED_MESSAGE } from '../loadError';
import { OUTCOME_META, outcomeInkVars } from '../outcome';
import { parseServerTime } from '../time';
import OutcomeDisc from '../OutcomeDisc';
import OutcomeMenu from '../OutcomeMenu';
import styles from './LeadDetail.module.scss';

// The writable subset — `LeadUpdate` in routes/admin_leads.py. Anything outside
// it is ignored server-side, so the form must not pretend to own it.
interface EnrichForm {
  contact_name: string;
  contact_title: string;
  direct_phone: string;
  contact_email: string;
  linkedin_url: string;
  hours_tz: string;
  notes: string;
}

// Server max_lengths, mirrored so the field stops the admin at the same place
// the API would 422 them.
const MAX: Record<keyof EnrichForm, number | undefined> = {
  contact_name: 120,
  contact_title: 120,
  direct_phone: 24,
  contact_email: 200,
  linkedin_url: 300,
  hours_tz: 40,
  notes: undefined, // Text column — unbounded
};

function toForm(lead: AdminLeadDetail): EnrichForm {
  return {
    contact_name: lead.contact_name ?? '',
    contact_title: lead.contact_title ?? '',
    direct_phone: lead.direct_phone ?? '',
    contact_email: lead.contact_email ?? '',
    linkedin_url: lead.linkedin_url ?? '',
    hours_tz: lead.hours_tz ?? '',
    notes: lead.notes ?? '',
  };
}

/** '' means "clear this field", which is a real edit — so send null, not ''. */
function orNull(value: string): string | null {
  const t = value.trim();
  return t ? t : null;
}

function formatStamp(iso: string): string {
  const d = new Date(parseServerTime(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface RowProps {
  label: string;
  children: ReactNode;
}

function KvRow({ label, children }: RowProps) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [lead, setLead] = useState<AdminLeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoBlocked, setDemoBlocked] = useState(false);
  // A 401 — see ../loadError.ts. Recovery, not a message.
  const [sessionExpired, setSessionExpired] = useState(false);
  const { logout } = useAuth();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EnrichForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    // Review finding: browser Back between two lead details kept a stale
    // anchor to a DETACHED button — the menu re-rendered pinned at the
    // viewport corner for the new lead. New id, clean slate.
    setMenuAnchor(null);
    setSaveError('');
    adminApi
      .getLead(id)
      .then((res) => {
        if (cancelled) return;
        setLead(res);
        setForm(toForm(res));
        // A row nobody has enriched yet opens straight into the form: that IS
        // the job on this page, and one fewer click per row over ~189 rows.
        setEditing(res.needs_enrichment);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        const failure = classifyLeadsError(err, 'Could not load this lead.');
        setDemoBlocked(failure.kind === 'demo');
        setSessionExpired(failure.kind === 'session');
        setError(failure.kind === 'failed' ? failure.message : '');
        if (failure.kind === 'failed') console.error('[LeadDetailPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The interceptor already dropped the dead token; clearing AuthContext is
  // what actually bounces the console to the sign-in screen (logout(), never a
  // navigate() — LoginPage sends an authenticated visitor straight back).
  useEffect(() => {
    if (!sessionExpired) return;
    if (localStorage.getItem('admin_token') === null) logout();
  }, [sessionExpired, logout]);

  // ONE exit path for edit mode — the header toggle and the form's Cancel
  // used to carry the same three calls in different order (drift bait).
  const stopEditing = (nextEditing = false) => {
    setEditing(nextEditing);
    setSaveError('');
    if (lead) setForm(toForm(lead));
  };

  const applyDetail = (detail: AdminLeadDetail) => {
    setLead(detail);
    // Review finding: recording an outcome mid-call used to wipe the OPEN
    // enrichment form (half-typed name/phone gone, no warning). The server
    // response only changes outcome denorms, never the fields being typed —
    // keep the admin's draft while editing.
    if (!editing) setForm(toForm(detail));
  };

  const save = async () => {
    if (!id || !form || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const updated = (await adminApi.updateLead(id, {
        contact_name: orNull(form.contact_name),
        contact_title: orNull(form.contact_title),
        direct_phone: orNull(form.direct_phone),
        contact_email: orNull(form.contact_email),
        linkedin_url: orNull(form.linkedin_url),
        hours_tz: orNull(form.hours_tz),
        notes: orNull(form.notes),
      })) as AdminLeadDetail;
      applyDetail(updated);
      setEditing(false);
    } catch (err) {
      const failure = classifyLeadsError(err, 'Could not save those details.');
      if (failure.kind === 'session') setSessionExpired(true);
      setSaveError(failure.message);
    } finally {
      setSaving(false);
    }
  };

  if (sessionExpired) {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: 'Leads', href: '/admin/leads' }, { label: 'Lead' }]} />
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Signed out</p>
            <p className={styles.blockedBody}>{SESSION_EXPIRED_MESSAGE}</p>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={logout}
            >
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
        <Breadcrumbs items={[{ label: 'Leads', href: '/admin/leads' }, { label: 'Lead' }]} />
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Not available in demo</p>
            <p className={styles.blockedBody}>
              Lead records hold real contact details, so the demo account is refused at the API.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className={styles.loading}>Loading lead…</div>;
  }

  if (error || !lead || !form) {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: 'Leads', href: '/admin/leads' }, { label: 'Lead' }]} />
        <div className={styles.errorPanel}>{error || 'Lead not found.'}</div>
      </div>
    );
  }

  const headline = lead.contact_name ?? lead.company_name;
  const site = lead.website ? safeHttpUrl(lead.website) : null;
  const linkedin = lead.linkedin_url ? safeHttpUrl(lead.linkedin_url) : null;
  const address = [lead.city, lead.state, lead.postal_code].filter(Boolean).join(', ');
  const converted = lead.last_outcome === 'converted';
  const lastMeta = lead.last_outcome ? OUTCOME_META[lead.last_outcome] : null;

  const setField = (key: keyof EnrichForm, value: string) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  // The enrichment form re-renders the page per keystroke; the append-only
  // timeline (unbounded history, Intl-formatted stamps, disc styles) is the
  // expensive part — memoized against everything except the history itself.
  const timeline = useMemo(
    () =>
      lead ? (
        <ol className={styles.timeline}>
                {lead.contacts.map((c) => {
                  const meta = OUTCOME_META[c.outcome];
                  return (
                    <li key={c.id} className={styles.entry}>
                      <div className={styles.entryDisc}>
                        <OutcomeDisc
                          outcome={c.outcome}
                          contactName={c.recorded_by}
                          size={22}
                        />
                      </div>
                      <div className={styles.entryBody}>
                        <p className={styles.entryHead}>
                          <span className={styles.entryWord} style={outcomeInkVars(meta)}>
                            <span aria-hidden="true">{meta.glyph}</span>
                            {meta.word}
                          </span>
                          {c.sale_tier && (
                            <span className={styles.tierLabel}>{c.sale_tier}</span>
                          )}
                        </p>
                        {c.note && <p className={styles.entryNote}>{c.note}</p>}
                        <p className={styles.entryMeta}>
                          {c.recorded_by ? (
                            <Link
                              to={`/admin/leads/reps/${encodeURIComponent(c.recorded_by)}`}
                              className={styles.repLink}
                            >
                              {c.recorded_by}
                            </Link>
                          ) : (
                            <span className={styles.muted}>unknown rep</span>
                          )}
                          <span className={styles.dot} aria-hidden="true">
                            &middot;
                          </span>
                          {formatStamp(c.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
      ) : null,
    [lead?.contacts],
  );

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[{ label: 'Leads', href: '/admin/leads' }, { label: lead.company_name }]}
      />

      <header className={styles.pageHead}>
        <div className={styles.identity}>
          <OutcomeDisc outcome={lead.last_outcome} contactName={lead.contact_name} size={40} />
          <div className={styles.identityText}>
            <h1 className={styles.title}>{headline}</h1>
            <p className={styles.subtitle}>
              {lead.contact_title ? `${lead.contact_title} · ` : ''}
              {lead.company_name}
              {lead.branch_label ? ` · ${lead.branch_label}` : ''}
            </p>
            <p className={styles.statusLine}>
              {lastMeta ? (
                <span className={styles.outcomeText} style={outcomeInkVars(lastMeta)}>
                  <span aria-hidden="true">{lastMeta.glyph}</span>
                  {lastMeta.word}
                </span>
              ) : (
                <span className={styles.muted}>Never contacted</span>
              )}
              <span className={styles.dot} aria-hidden="true">
                &middot;
              </span>
              <span className={styles.muted}>
                {lead.contact_attempts} {lead.contact_attempts === 1 ? 'attempt' : 'attempts'}
              </span>
            </p>
          </div>
        </div>

        <div className={styles.pageHeadActions}>
          {converted && (
            // Navigation only. An outcome NEVER writes a sponsor row, so the
            // label names the desk that actually does.
            <Link to="/admin/sponsors" className={styles.quoteBtn}>
              <span className={styles.quoteMain}>Start a quote &rarr;</span>
              <span className={styles.quoteSub}>via the sponsors desk</span>
            </Link>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            aria-haspopup="dialog"
            aria-expanded={menuAnchor != null}
            onClick={(e) => {
              const anchor = e.currentTarget;
              setMenuAnchor((prev) => (prev ? null : anchor));
            }}
          >
            Record outcome
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => stopEditing(!editing)}
          >
            {editing ? (
              <>
                <X size={14} strokeWidth={2} />
                Cancel
              </>
            ) : (
              <>
                <Pencil size={14} strokeWidth={2} />
                Edit
              </>
            )}
          </button>
        </div>
      </header>

      <div className={styles.detailGrid}>
        <div className={styles.mainCol}>
          {/* ── Contact ─────────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Contact</h2>
              {lead.needs_enrichment && !editing && (
                <span className={styles.enrichChip}>needs enrichment</span>
              )}
            </div>

            {editing ? (
              <form
                className={styles.form}
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className={styles.formGrid}>
                  {/* Every field is type="text": type="email"/"url"/"tel" makes
                      an HTML5-invalid value kill submit SILENTLY — no onSubmit,
                      no styling, no console error (repo gotcha + pytest guard). */}
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Contact name</span>
                    <input
                      type="text"
                      className={styles.input}
                      maxLength={MAX.contact_name}
                      value={form.contact_name}
                      onChange={(e) => setField('contact_name', e.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Title</span>
                    <input
                      type="text"
                      className={styles.input}
                      maxLength={MAX.contact_title}
                      value={form.contact_title}
                      onChange={(e) => setField('contact_title', e.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Direct phone</span>
                    <input
                      type="text"
                      inputMode="tel"
                      className={styles.input}
                      maxLength={MAX.direct_phone}
                      value={form.direct_phone}
                      onChange={(e) => setField('direct_phone', e.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Contact email</span>
                    <input
                      type="text"
                      inputMode="email"
                      className={styles.input}
                      maxLength={MAX.contact_email}
                      value={form.contact_email}
                      onChange={(e) => setField('contact_email', e.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>LinkedIn URL</span>
                    <input
                      type="text"
                      inputMode="url"
                      className={styles.input}
                      maxLength={MAX.linkedin_url}
                      value={form.linkedin_url}
                      onChange={(e) => setField('linkedin_url', e.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Hours / time zone</span>
                    <input
                      type="text"
                      className={styles.input}
                      maxLength={MAX.hours_tz}
                      value={form.hours_tz}
                      onChange={(e) => setField('hours_tz', e.target.value)}
                    />
                  </label>
                </div>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Notes</span>
                  <textarea
                    className={styles.textarea}
                    rows={3}
                    value={form.notes}
                    onChange={(e) => setField('notes', e.target.value)}
                  />
                </label>

                {saveError && (
                  <p className={styles.formError} role="alert">
                    {saveError}
                  </p>
                )}

                <div className={styles.formActions}>
                  <button
                    type="submit"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save contact'}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    onClick={() => stopEditing()}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <dl className={styles.kvList}>
                <KvRow label="Name">
                  {lead.contact_name ?? <span className={styles.muted}>&mdash;</span>}
                </KvRow>
                <KvRow label="Title">
                  {lead.contact_title ?? <span className={styles.muted}>&mdash;</span>}
                </KvRow>
                <KvRow label="Direct">
                  {lead.direct_phone ? (
                    <a className={styles.link} href={`tel:${lead.direct_phone}`}>
                      {lead.direct_phone}
                    </a>
                  ) : (
                    <span className={styles.muted}>&mdash;</span>
                  )}
                </KvRow>
                <KvRow label="Email">
                  {lead.contact_email ? (
                    <a className={styles.link} href={`mailto:${lead.contact_email}`}>
                      {lead.contact_email}
                    </a>
                  ) : (
                    <span className={styles.muted}>&mdash;</span>
                  )}
                </KvRow>
                <KvRow label="LinkedIn">
                  {linkedin ? (
                    <a
                      className={styles.link}
                      href={linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {lead.linkedin_url}
                    </a>
                  ) : lead.linkedin_url ? (
                    // safeHttpUrl rejected it — show the stored text, never
                    // make a javascript:/data: value clickable.
                    <span className={styles.muted}>{lead.linkedin_url}</span>
                  ) : (
                    <span className={styles.muted}>&mdash;</span>
                  )}
                </KvRow>
                <KvRow label="Hours">
                  {lead.hours_tz ?? <span className={styles.muted}>&mdash;</span>}
                </KvRow>
              </dl>
            )}
          </section>

          {/* ── Company ─────────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Company</h2>
              {lead.manufacturer_id && (
                <Link
                  to={`/admin/manufacturers/${lead.manufacturer_id}`}
                  className={styles.panelLink}
                >
                  Open in Manufacturers &rarr;
                </Link>
              )}
            </div>
            <dl className={styles.kvList}>
              <KvRow label="Company">
                <span className={styles.strong}>{lead.company_name}</span>
                {lead.branch_label && (
                  <span className={styles.branchChip}>{lead.branch_label}</span>
                )}
              </KvRow>
              <KvRow label="Size / ring">
                <span className={styles.chip}>{lead.tier ?? '?'}</span>
                <span className={styles.chip}>
                  {lead.ring === 'UNVERIFIED' ? 'ring unverified' : `ring ${lead.ring ?? '?'}`}
                </span>
              </KvRow>
              <KvRow label="Address">
                {lead.street || address ? (
                  <>
                    {lead.street && <div>{lead.street}</div>}
                    {address && <div>{address}</div>}
                  </>
                ) : (
                  <span className={styles.muted}>&mdash;</span>
                )}
              </KvRow>
              <KvRow label="Main phone">
                {lead.main_phone ? (
                  <a className={styles.link} href={`tel:${lead.main_phone}`}>
                    {lead.main_phone}
                  </a>
                ) : (
                  <span className={styles.muted}>&mdash;</span>
                )}
              </KvRow>
              <KvRow label="Sales email">
                {lead.sales_email ? (
                  <a className={styles.link} href={`mailto:${lead.sales_email}`}>
                    {lead.sales_email}
                  </a>
                ) : (
                  <span className={styles.muted}>&mdash;</span>
                )}
              </KvRow>
              <KvRow label="Website">
                {site ? (
                  <a className={styles.link} href={site} target="_blank" rel="noopener noreferrer">
                    {lead.website}
                  </a>
                ) : lead.website ? (
                  <span className={styles.muted}>{lead.website}</span>
                ) : (
                  <span className={styles.muted}>&mdash;</span>
                )}
              </KvRow>
            </dl>
          </section>

          {!editing && lead.notes && (
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2 className={styles.panelTitle}>Notes</h2>
              </div>
              <div className={styles.panelBody}>
                <p className={styles.notesText}>{lead.notes}</p>
              </div>
            </section>
          )}
        </div>

        {/* ── History ───────────────────────────────────────────────────── */}
        <aside className={styles.sideCol}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Contact history</h2>
              <span className={styles.countBadge}>{lead.contacts.length}</span>
            </div>
            {lead.contacts.length === 0 ? (
              <div className={styles.panelBody}>
                <p className={styles.emptyHistory}>
                  No calls recorded yet. Use <strong>Record outcome</strong> above after the first
                  conversation.
                </p>
              </div>
            ) : (
              // Newest first — the API orders `contacts` desc, so no client
              // sort. Memoized above against form keystrokes.
              timeline
            )}
          </section>
        </aside>
      </div>

      {menuAnchor && (
        <OutcomeMenu
          leadId={lead.id}
          anchor={menuAnchor}
          label={headline}
          onRecorded={applyDetail}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
}
