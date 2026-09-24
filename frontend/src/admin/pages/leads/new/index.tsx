// Add a lead — a rep puts a prospect on the call list by hand, often while the
// prospect is still on the phone. (The roster itself is still seeded from
// seed_data/leads.csv; this is the door for everyone met since.)
//
// Design, in one line: the company and the person lead, everything else is
// optional depth beside them, and the page answers "are they already on the
// list?" while the rep is still typing the company name.
//
//   • The main panel holds what a call yields: company, person, a way to reach
//     them, notes. The side column (company details, location) can wait.
//   • The one bold element is the match rail under Company name — a PCB trace
//     dropping from the field to the leads already on the list, each a link.
//     It is a HINT from the list search; the server's 409 is the authority and
//     renders in the same place, refused-amber, naming the existing lead.
//   • "Add and start another" keeps the company and its address for the next
//     person at the same company (the roster lists several per company).
//
// Inputs are text fields with an inputMode and the form is noValidate: the
// browser's own typed fields swallow submit on a value they dislike (CLAUDE.md).
// Every rule lives in leadForm.ts, mirrored 1:1 from the server's LeadCreate.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import ListSelect, { type ListOption } from '@admin/components/ListSelect/ListSelect';
import { TextRow } from '@admin/components/ListSelect/PriceRow';
import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorCode, apiErrorDetail } from '@admin/services/apiError';
import { useConsolePath } from '@admin/services/consolePath';
import type { AdminLead, LeadExistsDetail, LeadTier } from '@admin/types/leads';

import { classifyLeadsError } from '../loadError';
import OutcomeDisc from '../OutcomeDisc';
import {
  EMPTY_LEAD_FORM,
  LEAD_MAX,
  buildLeadBody,
  carryCompany,
  codePoints,
  isExactLeadMatch,
  leadLabel,
  looseKey,
  matchAnnouncement,
  readLeadExists,
  serverFieldErrors,
  validateLeadForm,
  type LeadFormErrors,
  type LeadFormField,
  type LeadFormState,
  type LeadTextField,
} from './leadForm';
import styles from './LeadNew.module.scss';

// DOM order — the first invalid field in this order takes focus on submit.
const FIELD_ORDER: LeadFormField[] = [
  'company_name',
  'contact_name',
  'contact_title',
  'direct_phone',
  'contact_email',
  'linkedin_url',
  'hours_tz',
  'notes',
  'tier',
  'website',
  'main_phone',
  'sales_email',
  'street',
  'city',
  'state',
  'postal_code',
];

const fieldId = (field: LeadFormField) => `lead-${field}`;

const TIER_OPTIONS: ListOption<LeadTier | ''>[] = [
  { value: '', label: 'Not set', content: <TextRow main="Not set" /> },
  { value: 'S', label: 'Small', keys: ['s'], content: <TextRow main="Small" note="S" /> },
  { value: 'M', label: 'Medium', keys: ['m'], content: <TextRow main="Medium" note="M" /> },
  { value: 'L', label: 'Large', keys: ['l'], content: <TextRow main="Large" note="L" /> },
];

// The live check waits for a pause in typing and a name long enough to mean
// something; it shows at most this many rows.
const MATCH_DEBOUNCE_MS = 300;
const MATCH_MIN_CHARS = 3;
const MATCH_ROWS = 3;
// How many rows the probe asks for; a full page means the list may hold more.
const MATCH_FETCH = 20;
// The counter under Notes appears once the rep is near the limit.
const NOTES_COUNTER_FROM = 3200;

// Read by Wizard.module.scss (`:global(body.has-sticky-actions) .welcome`).
const STICKY_ACTIONS_CLASS = 'has-sticky-actions';

const SAVE_FALLBACK = 'The lead was not added. Check your connection, then try again.';

type SaveMode = 'open' | 'another';

interface Added {
  id: string;
  label: string;
}

// ─── Field primitives ───────────────────────────────────────────────────────

interface TextFieldProps {
  field: LeadTextField;
  label: string;
  form: LeadFormState;
  errors: LeadFormErrors;
  onChange: (field: LeadTextField, value: string) => void;
  required?: boolean;
  hint?: ReactNode;
  inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric';
  mono?: boolean;
  placeholder?: string;
  maxLength?: number;
  transform?: (value: string) => string;
  inputRef?: React.Ref<HTMLInputElement>;
  children?: ReactNode;
  className?: string;
}

function TextField({
  field,
  label,
  form,
  errors,
  onChange,
  required,
  hint,
  inputMode = 'text',
  mono,
  placeholder,
  maxLength,
  transform,
  inputRef,
  children,
  className,
}: TextFieldProps) {
  const id = fieldId(field);
  const error = errors[field];
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required && (
          <span className={styles.req} aria-hidden="true">
            *
          </span>
        )}
      </label>
      <input
        ref={inputRef}
        id={id}
        name={field}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        autoCapitalize={inputMode === 'email' || inputMode === 'url' ? 'none' : undefined}
        spellCheck={inputMode === 'email' || inputMode === 'url' ? false : undefined}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        maxLength={maxLength}
        placeholder={placeholder}
        className={`${styles.input} ${mono ? styles.mono : ''}`}
        data-invalid={error ? '' : undefined}
        value={form[field]}
        onChange={(e) => onChange(field, transform ? transform(e.target.value) : e.target.value)}
      />
      {error && (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
      {children}
      {hint && !error && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ─── The match rail ─────────────────────────────────────────────────────────

interface MatchRailProps {
  matches: AdminLead[];
  more: boolean;
  exactId: string | null;
  consolePath: (p: string) => string;
}

function MatchRail({ matches, more, exactId, consolePath }: MatchRailProps) {
  const exact = exactId ? matches.find((m) => m.id === exactId) ?? null : null;
  return (
    // Not a live region: it mounts WITH its text, which screen readers skip.
    // The always-mounted status beside it (matchAnnouncement) speaks for it.
    <div className={styles.rail} data-exact={exact ? '' : undefined}>
      <p className={styles.railHead}>
        {exact
          ? `${leadLabel(exact.contact_name, exact.company_name)} is already on the call list`
          : 'Already on the call list'}
      </p>
      <ul className={styles.railList}>
        {matches.map((lead) => (
          <li key={lead.id} className={styles.railRow} data-exact={lead.id === exactId ? '' : undefined}>
            <OutcomeDisc outcome={lead.last_outcome} contactName={lead.contact_name} size={22} />
            <span className={styles.railText}>
              <span className={styles.railName}>{lead.contact_name ?? lead.company_name}</span>
              <span className={styles.railSub}>
                {lead.contact_name ? lead.company_name : 'Company only'}
                {lead.city ? `, ${lead.city}` : ''}
              </span>
            </span>
            <Link
              to={consolePath(`/admin/leads/${lead.id}`)}
              className={styles.railOpen}
              aria-label={`Open ${leadLabel(lead.contact_name, lead.company_name)}`}
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
      {more && <p className={styles.railMore}>More on the list. Search Leads to see them all.</p>}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

function Notice({ title, children }: { title: string; children: ReactNode }) {
  const consolePath = useConsolePath();
  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Leads', href: consolePath('/admin/leads') }, { label: 'Add a lead' }]} />
      <div className={styles.notice}>
        <h1 className={styles.noticeTitle}>{title}</h1>
        <p className={styles.noticeBody}>{children}</p>
      </div>
    </div>
  );
}

function AddLeadForm() {
  const consolePath = useConsolePath();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const titleId = useId();

  const [form, setForm] = useState<LeadFormState>(EMPTY_LEAD_FORM);
  const [errors, setErrors] = useState<LeadFormErrors>({});
  const [saving, setSaving] = useState<SaveMode | null>(null);
  const [formError, setFormError] = useState('');
  const [exists, setExists] = useState<LeadExistsDetail | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [matches, setMatches] = useState<AdminLead[]>([]);
  // Bumped after "Add and start another" so the rail picks up the lead just added.
  const [probeNonce, setProbeNonce] = useState(0);

  const companyRef = useRef<HTMLInputElement | null>(null);
  const contactRef = useRef<HTMLInputElement | null>(null);
  const existsRef = useRef<HTMLDivElement | null>(null);

  // Mid-call speed: the cursor starts in Company name.
  useEffect(() => {
    companyRef.current?.focus();
  }, []);

  // The sticky save bar sits where the wizard's first-session "Need a
  // walkthrough?" bubble floats (z 9999, click = dismiss), so a new rep's
  // first click on "Add lead" would only dismiss it. The mark hides the
  // bubble (Wizard.module.scss) while this bar is on screen; it is not
  // dismissed, so it greets them again on the next page.
  useEffect(() => {
    document.body.classList.add(STICKY_ACTIONS_CLASS);
    return () => document.body.classList.remove(STICKY_ACTIONS_CLASS);
  }, []);

  // The live "already on the list" check. The list search (q) also matches
  // contacts, cities and notes, so the rows are narrowed to companies whose
  // name contains what was typed.
  const typedCompany = form.company_name.trim();
  useEffect(() => {
    const needle = looseKey(typedCompany);
    if (needle.length < MATCH_MIN_CHARS) {
      setMatches([]);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      adminApi
        .getLeads({ q: typedCompany, page: 1, per_page: MATCH_FETCH, sort: 'company' })
        .then((res) => {
          if (cancelled) return;
          setMatches(res.leads.filter((l) => looseKey(l.company_name).includes(needle)));
        })
        .catch(() => {
          // A hint, not a gate: a failed probe shows nothing and blocks nothing.
          if (!cancelled) setMatches([]);
        });
    }, MATCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [typedCompany, probeNonce]);

  // The exact person (same company, same contact) — the row the server would
  // refuse. A hint; canon() on the server decides.
  const exactMatch = matches.find((l) => isExactLeadMatch(l, form)) ?? null;
  const shownMatches = (() => {
    const head = matches.slice(0, MATCH_ROWS);
    if (exactMatch && !head.some((m) => m.id === exactMatch.id)) head[head.length - 1] = exactMatch;
    return head;
  })();

  const setField = (field: LeadTextField, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    // The refusal named a company + contact pair; editing either may resolve it.
    if (field === 'company_name' || field === 'contact_name') setExists(null);
    setFormError('');
  };

  const focusField = (field: LeadFormField) => {
    document.getElementById(fieldId(field))?.focus();
  };

  async function submit(mode: SaveMode) {
    if (saving) return;
    const found = validateLeadForm(form);
    setErrors(found);
    setExists(null);
    setFormError('');
    const firstBad = FIELD_ORDER.find((f) => found[f]);
    if (firstBad) {
      focusField(firstBad);
      return;
    }

    setSaving(mode);
    try {
      const lead = await adminApi.createLead(buildLeadBody(form));
      if (mode === 'open') {
        navigate(consolePath(`/admin/leads/${lead.id}`));
        return;
      }
      setAdded({ id: lead.id, label: leadLabel(lead.contact_name, lead.company_name) });
      // From the LATEST state: the inputs stay live during the POST, and an
      // edit to a carried field made meanwhile must survive the reset.
      setForm((prev) => carryCompany(prev));
      setErrors({});
      setProbeNonce((n) => n + 1);
      contactRef.current?.focus();
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const data = axios.isAxiosError(err) ? err.response?.data : undefined;

      const duplicate = readLeadExists(status, data);
      if (duplicate) {
        setExists(duplicate);
        requestAnimationFrame(() => existsRef.current?.focus());
        return;
      }

      if (status === 422) {
        const fieldErrors = serverFieldErrors(data);
        const first = FIELD_ORDER.find((f) => fieldErrors[f]);
        if (first) {
          setErrors(fieldErrors);
          focusField(first);
          return;
        }
      }

      const { code } = apiErrorCode(err);
      if (status === 403 && code === 'read_only') {
        setFormError(apiErrorDetail(err) ?? 'This account is view-only, so it cannot add leads.');
        return;
      }
      const failure = classifyLeadsError(err, SAVE_FALLBACK);
      if (failure.kind === 'session') {
        // The token is gone. Signing out bounces to the sign-in screen; the
        // typed lead is lost, which is why the message says so first.
        setFormError(failure.message);
        if (localStorage.getItem('admin_token') === null) logout();
        return;
      }
      if (failure.kind === 'demo') {
        setFormError('This account cannot see the call list, so it cannot add to it.');
        return;
      }
      console.error('[AddLead] save failed', err);
      setFormError(failure.message);
    } finally {
      setSaving(null);
    }
  }

  const errorCount = FIELD_ORDER.filter((f) => errors[f]).length;
  const notesLength = codePoints(form.notes.trim());
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.userAgent);
  const saveChord = isMac ? '⌘ Return' : 'Ctrl + Enter';

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Leads', href: consolePath('/admin/leads') }, { label: 'Add a lead' }]} />

      <header className={styles.head}>
        <h1 className={styles.title} id={titleId}>
          Add a lead
        </h1>
        <p className={styles.subtitle}>
          Only the company is required. Get the person and a way to reach them while they are on
          the line; the rest can wait.
        </p>
      </header>

      {added && (
        <p className={styles.addedBar} role="status">
          <span>
            Added {added.label}. The company and address are kept for the next contact.
          </span>
          <Link to={consolePath(`/admin/leads/${added.id}`)} className={styles.addedOpen}>
            Open lead
          </Link>
        </p>
      )}

      <form
        className={styles.form}
        aria-labelledby={titleId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit('open');
        }}
        onKeyDown={(e) => {
          // Enter already submits from a one-line field; the chord covers Notes.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit('open');
          }
        }}
      >
        <div className={styles.layout}>
          <section className={`${styles.panel} ${styles.mainPanel}`} aria-labelledby="lead-main-title">
            <h2 className={styles.panelTitle} id="lead-main-title">
              Company and contact
            </h2>

            <TextField
              field="company_name"
              label="Company name"
              required
              form={form}
              errors={errors}
              onChange={setField}
              inputRef={companyRef}
              placeholder="e.g. Bisco Industries (Bohemia)"
              hint="Put a branch in parentheses and it is filed as that branch."
              className={styles.companyField}
            >
              {exists ? (
                <div className={styles.rail} data-refused="" role="alert" tabIndex={-1} ref={existsRef}>
                  {exists.code === 'lead_exists' ? (
                    <>
                      <p className={styles.railHead}>
                        {leadLabel(exists.contact_name, exists.company_name)} is already on the call
                        list, so this was not added.
                      </p>
                      <p className={styles.railBody}>
                        Open that lead to record the call, or change the contact name to add a
                        different person at this company.
                      </p>
                      <Link to={consolePath(`/admin/leads/${exists.lead_id}`)} className={styles.railCta}>
                        Open {exists.contact_name ?? exists.company_name}
                      </Link>
                    </>
                  ) : (
                    <>
                      <p className={styles.railHead}>
                        A lead with this company and contact already exists, so this was not added.
                      </p>
                      <p className={styles.railBody}>
                        Change the contact name to add a different person at this company.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                shownMatches.length > 0 && (
                  <MatchRail
                    matches={shownMatches}
                    more={matches.length > MATCH_ROWS}
                    exactId={exactMatch?.id ?? null}
                    consolePath={consolePath}
                  />
                )
              )}
              {/* Always mounted, so a screen reader hears the rail APPEAR (a live
                  region inserted with its text is silent). Quiet while the
                  refusal speaks for itself as an alert. */}
              <p className={styles.srOnly} role="status" aria-live="polite">
                {exists ? '' : matchAnnouncement(matches, exactMatch, matches.length >= MATCH_FETCH)}
              </p>
            </TextField>

            <div className={styles.pair}>
              <TextField
                field="contact_name"
                label="Contact name"
                form={form}
                errors={errors}
                onChange={setField}
                inputRef={contactRef}
                hint={form.contact_name.trim() ? undefined : 'Leave blank to add the company alone.'}
              />
              <TextField field="contact_title" label="Title" form={form} errors={errors} onChange={setField} />
            </div>

            <div className={styles.pair}>
              <TextField
                field="direct_phone"
                label="Direct phone"
                inputMode="tel"
                form={form}
                errors={errors}
                onChange={setField}
              />
              <TextField
                field="contact_email"
                label="Email"
                inputMode="email"
                placeholder="name@company.com"
                form={form}
                errors={errors}
                onChange={setField}
              />
            </div>

            <div className={styles.pair}>
              <TextField
                field="linkedin_url"
                label="LinkedIn"
                inputMode="url"
                mono
                placeholder="linkedin.com/in/…"
                form={form}
                errors={errors}
                onChange={setField}
              />
              <TextField
                field="hours_tz"
                label="Hours or time zone"
                placeholder="e.g. ET, 8–5"
                form={form}
                errors={errors}
                onChange={setField}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={fieldId('notes')}>
                Notes
              </label>
              <textarea
                id={fieldId('notes')}
                name="notes"
                rows={4}
                className={styles.textarea}
                data-invalid={errors.notes ? '' : undefined}
                aria-invalid={errors.notes ? true : undefined}
                aria-describedby={errors.notes ? 'lead-notes-error' : 'lead-notes-hint'}
                placeholder="What they make, who they buy from, when to call back"
                value={form.notes}
                onChange={(e) => setField('notes', e.target.value)}
              />
              {errors.notes ? (
                <p id="lead-notes-error" className={styles.fieldError}>
                  {errors.notes}
                </p>
              ) : (
                <p id="lead-notes-hint" className={styles.hint}>
                  <span>{saveChord} adds the lead from anywhere in the form.</span>
                  {notesLength >= NOTES_COUNTER_FROM && (
                    <span className={styles.counter}>
                      {notesLength.toLocaleString('en-US')} / {LEAD_MAX.notes.toLocaleString('en-US')}
                    </span>
                  )}
                </p>
              )}
            </div>
          </section>

          <div className={styles.side}>
            <section className={styles.panel} aria-labelledby="lead-company-title">
              <h2 className={styles.panelTitle} id="lead-company-title">
                More about the company
              </h2>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={fieldId('tier')}>
                  Size
                </label>
                <ListSelect
                  id={fieldId('tier')}
                  value={form.tier}
                  options={TIER_OPTIONS}
                  placeholder="Not set"
                  onChange={(tier) => setForm((prev) => ({ ...prev, tier }))}
                />
              </div>
              <TextField
                field="website"
                label="Website"
                inputMode="url"
                mono
                placeholder="acme.com"
                form={form}
                errors={errors}
                onChange={setField}
              />
              <TextField
                field="main_phone"
                label="Main phone"
                inputMode="tel"
                form={form}
                errors={errors}
                onChange={setField}
              />
              <TextField
                field="sales_email"
                label="Sales email"
                inputMode="email"
                placeholder="sales@company.com"
                form={form}
                errors={errors}
                onChange={setField}
              />
            </section>

            <section className={styles.panel} aria-labelledby="lead-place-title">
              <h2 className={styles.panelTitle} id="lead-place-title">
                Location
              </h2>
              <TextField field="street" label="Street" form={form} errors={errors} onChange={setField} />
              <TextField field="city" label="City" form={form} errors={errors} onChange={setField} />
              <div className={styles.stateZip}>
                <TextField
                  field="state"
                  label="State"
                  placeholder="NY"
                  transform={(v) => v.toUpperCase()}
                  form={form}
                  errors={errors}
                  onChange={setField}
                />
                <TextField
                  field="postal_code"
                  label="ZIP"
                  inputMode="numeric"
                  placeholder="11779"
                  form={form}
                  errors={errors}
                  onChange={setField}
                />
              </div>
              <p className={styles.hint}>The ZIP sets the distance from HQ on the call list.</p>
            </section>
          </div>
        </div>

        <div className={styles.actions}>
          <div className={styles.actionsStatus}>
            {errorCount > 0 && (
              <p className={styles.actionsError} role="alert">
                {errorCount === 1
                  ? 'One field needs a fix before this lead can be added.'
                  : `${errorCount} fields need a fix before this lead can be added.`}
              </p>
            )}
            {formError && (
              <p className={styles.actionsError} role="alert">
                {formError}
              </p>
            )}
          </div>
          <Link
            to={consolePath('/admin/leads')}
            className={`${styles.btn} ${styles.btnQuiet} ${styles.btnCancel}`}
          >
            Cancel
          </Link>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            disabled={saving !== null}
            onClick={() => void submit('another')}
          >
            {saving === 'another' ? (
              'Adding…'
            ) : (
              // One label is visible at a time (display:none drops the other
              // from the accessible name), so what a voice user reads is what
              // they can say.
              <>
                <span className={styles.labelLong}>Add and start another</span>
                <span className={styles.labelShort}>Add another</span>
              </>
            )}
          </button>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving !== null}>
            {saving === 'open' ? 'Adding…' : 'Add lead'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function AddLeadPage() {
  const { isCustomer, isReadOnly } = useAuth();
  if (isCustomer) {
    return (
      <Notice title="Leads are kept by the Circuit Center team">
        The call list is internal to the sales team, so there is nothing to add here.
      </Notice>
    );
  }
  if (isReadOnly) {
    return (
      <Notice title="This account is view-only">
        Adding a lead changes the call list, which view-only accounts cannot do. Ask the owner for a
        staff account to add leads.
      </Notice>
    );
  }
  return <AddLeadForm />;
}
