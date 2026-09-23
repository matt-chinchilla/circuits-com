// New sales code (spec §9). A rep picks the discount (1–15 points off list,
// each step priced by the SERVER's ladder), optionally locks it to a tier, a
// placement, a company (R7: needs the customer's email) or an email, and
// gets back an 8-character code plus a ready /join link built from those
// locks. Codes are never edited here beyond the list's switch-off / extend;
// a different deal is a new code.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { adminApi, newIdempotencyKey } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { useAuth } from '@admin/contexts/AuthContext';
import { useConsolePath } from '@admin/services/consolePath';
import { copyText } from '@admin/services/clipboard';
import type { AdminCategory, AdminSupplier, QuoteLadderTier, SalesCode } from '@admin/types/admin';
import CodeTicket from '../CodeTicket';
import {
  MAX_CODE_POINTS,
  absoluteLink,
  codeCreateBody,
  codeFormErrors,
  locksSummary,
  pointsOptionLabel,
  type CodeFormErrors,
  type CodeFormState,
} from '../salesCodes';
import styles from '../SalesCodes.module.scss';

const EXPIRY_CHOICES = [7, 14, 30, 60, 90];
const POINT_CHOICES = Array.from({ length: MAX_CODE_POINTS }, (_, i) => i + 1);

function emptyForm(rep: string): CodeFormState {
  return {
    points: 10,
    tier: 'any',
    categoryId: '',
    supplierId: '',
    emailLock: '',
    maxUses: '1',
    expiresInDays: 14,
    rep,
    note: '',
  };
}

function StaffNewSalesCodePage() {
  const consolePath = useConsolePath();
  const { user, isReadOnly } = useAuth();
  const me = user?.username ?? '';

  const [form, setForm] = useState<CodeFormState>(() => emptyForm(me));
  const [errors, setErrors] = useState<CodeFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<SalesCode | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [reps, setReps] = useState<string[]>([]);
  const [ladder, setLadder] = useState<Record<string, QuoteLadderTier> | null>(null);

  // One key per distinct request body: a retry of the SAME code reaches the
  // server as the same request; an edited form is a new request.
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    adminApi.getCategories().then((rows) => !cancelled && setCategories(rows)).catch(() => {});
    adminApi.getSuppliers().then((rows) => !cancelled && setSuppliers(rows)).catch(() => {});
    adminApi
      .getSalesRepOptions()
      .then((r) => !cancelled && setReps(r.reps))
      .catch(() => {});
    adminApi
      .getQuoteLadder()
      .then((r) => !cancelled && setLadder(r.tiers))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof CodeFormState>(key: K, value: CodeFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setServerError(null);
  };

  // Gold sells a subcategory, Platinum a top-level category (the tier matrix).
  const placementOptions = useMemo(() => {
    if (form.tier === 'platinum') {
      return [...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name, group: '' }));
    }
    if (form.tier === 'gold') {
      return [...categories]
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((parent) =>
          [...parent.children]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => ({ id: child.id, label: child.name, group: parent.name })),
        );
    }
    return [];
  }, [categories, form.tier]);

  const groupedPlacements = useMemo(() => {
    const groups = new Map<string, { id: string; label: string }[]>();
    for (const o of placementOptions) {
      const list = groups.get(o.group) ?? [];
      list.push(o);
      groups.set(o.group, list);
    }
    return [...groups.entries()];
  }, [placementOptions]);

  const sortedSuppliers = useMemo(
    () => [...suppliers].sort((a, b) => a.name.localeCompare(b.name)),
    [suppliers],
  );

  const repChoices = useMemo(() => {
    const set = new Set(reps);
    if (me) set.add(me);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [reps, me]);

  const chooseTier = (tier: CodeFormState['tier']) => {
    setForm((f) => ({ ...f, tier, categoryId: '' }));
    setErrors((e) => ({ ...e, categoryId: undefined }));
  };

  const chooseSupplier = (supplierId: string) => {
    const sup = suppliers.find((s) => s.id === supplierId);
    setForm((f) => ({
      ...f,
      supplierId,
      // Prefill from the supplier's email on file; the rep can overwrite it.
      emailLock: supplierId && !f.emailLock.trim() && sup?.email ? sup.email : f.emailLock,
    }));
    setErrors((e) => ({ ...e, emailLock: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = codeFormErrors(form);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    const body = codeCreateBody(form);
    const scope = JSON.stringify(body);
    let key = keys.current.get(scope);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(scope, key);
    }
    setSaving(true);
    setServerError(null);
    try {
      setCreated(await adminApi.createSalesCode(body, key));
      setCopied(null);
    } catch (err) {
      setServerError(apiErrorDetail(err) ?? 'The code was not created — try again.');
    } finally {
      setSaving(false);
    }
  };

  const startOver = () => {
    keys.current = new Map();
    setForm(emptyForm(me));
    setErrors({});
    setCreated(null);
  };

  const back = (
    <Link to={consolePath('/admin/sales-codes')} className={styles.backLink}>
      <ChevronLeft size={14} strokeWidth={2} />
      Sales codes
    </Link>
  );

  if (isReadOnly) {
    return (
      <div className={styles.pageNarrow}>
        {back}
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <p className={styles.quiet}>This account is view-only &mdash; it cannot create codes.</p>
          </div>
        </div>
      </div>
    );
  }

  if (created) {
    const link = absoluteLink(created.link, window.location.origin);
    return (
      <div className={styles.pageNarrow}>
        <header className={styles.pageHead}>
          <div className={styles.pageHeadLeft}>
            {back}
            <h1 className={styles.title}>Code ready</h1>
            <p className={styles.subtitle}>
              Send the customer the link &mdash; it opens /join with this code
              {created.category_id ? ' and the slot' : ''} filled in. It works until{' '}
              {new Date(created.expires_at).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'long',
                day: 'numeric',
              })}
              .
            </p>
          </div>
        </header>
        <div className={styles.panel}>
          <div className={styles.panelBody}>
            <div className={styles.created}>
              <CodeTicket
                large
                display={created.display}
                points={created.code_points}
                caption={locksSummary(created).join(' · ')}
              />
              <div className={styles.linkLine}>
                <code className={styles.linkText}>{link}</code>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={async () => setCopied((await copyText(link)) ? 'link' : null)}
                >
                  {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnGhost}`}
                  onClick={async () => setCopied((await copyText(created.display)) ? 'code' : null)}
                >
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className={`${styles.formActions} ${styles.afterPanel}`}>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={startOver}>
            Create another
          </button>
          <div className={styles.formActionsSpacer} />
          <Link to={consolePath('/admin/sales-codes')} className={`${styles.btn} ${styles.btnGhost}`}>
            Back to codes
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageNarrow}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          {back}
          <h1 className={styles.title}>New sales code</h1>
          <p className={styles.subtitle}>
            The customer pays the Founder&rsquo;s Deal less the code&rsquo;s points, never below
            70% of list. One code, one discount &mdash; codes never stack.
          </p>
        </div>
      </header>

      <form className={styles.formGrid} onSubmit={submit} noValidate>
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Discount</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <span className={styles.fieldLabel} id="tier-label">
                Tier
              </span>
              <fieldset className={styles.segmented} aria-labelledby="tier-label">
                {(['any', 'gold', 'platinum'] as const).map((t) => (
                  <label key={t}>
                    <input
                      type="radio"
                      name="tier"
                      value={t}
                      checked={form.tier === t}
                      onChange={() => chooseTier(t)}
                    />
                    {t === 'any' ? 'Gold or Platinum' : t === 'gold' ? 'Gold' : 'Platinum'}
                  </label>
                ))}
              </fieldset>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="points">
                Points off list <span className={styles.fieldReq}>*</span>
              </label>
              <select
                id="points"
                className={styles.select}
                value={form.points}
                onChange={(e) => update('points', Number(e.target.value))}
              >
                {POINT_CHOICES.map((p) => (
                  <option key={p} value={p}>
                    {pointsOptionLabel(p, ladder, form.tier)}
                  </option>
                ))}
              </select>
              <p className={styles.fieldHint}>
                Each point is 1% of list. The prices shown are what the customer will pay per
                month, tax included &mdash; the server sets them.
              </p>
              {errors.points && <div className={styles.fieldError}>{errors.points}</div>}
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Who can use it</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="placement">
                Placement
              </label>
              <select
                id="placement"
                className={styles.select}
                value={form.categoryId}
                disabled={form.tier === 'any'}
                onChange={(e) => update('categoryId', e.target.value)}
              >
                <option value="">Any open {form.tier === 'platinum' ? 'category' : form.tier === 'gold' ? 'subcategory' : 'slot'}</option>
                {groupedPlacements.map(([group, list]) =>
                  group ? (
                    <optgroup key={group} label={group}>
                      {list.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    list.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))
                  ),
                )}
              </select>
              <p className={styles.fieldHint}>
                {form.tier === 'any'
                  ? 'Pick Gold or Platinum above to lock the code to one slot.'
                  : 'Locking a slot pre-selects it on /join. A taken slot cannot be sold either way.'}
              </p>
              {errors.categoryId && <div className={styles.fieldError}>{errors.categoryId}</div>}
            </div>

            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="supplier">
                  Existing company
                </label>
                <select
                  id="supplier"
                  className={styles.select}
                  value={form.supplierId}
                  onChange={(e) => chooseSupplier(e.target.value)}
                >
                  <option value="">A new company (created at checkout)</option>
                  {sortedSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <p className={styles.fieldHint}>
                  Bind the sale to a company we already list, so its board and billing stay on
                  one record.
                </p>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="email-lock">
                  Customer email{form.supplierId && <span className={styles.fieldReq}>*</span>}
                </label>
                <input
                  id="email-lock"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  className={styles.textInput}
                  placeholder="Only this buyer can use it (optional)"
                  value={form.emailLock}
                  onChange={(e) => update('emailLock', e.target.value)}
                />
                {errors.emailLock ? (
                  <div className={styles.fieldError}>{errors.emailLock}</div>
                ) : (
                  <p className={styles.fieldHint}>The buyer must check out with this address.</p>
                )}
              </div>
            </div>

            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="max-uses">
                  Uses
                </label>
                <input
                  id="max-uses"
                  type="text"
                  inputMode="numeric"
                  className={styles.textInput}
                  value={form.maxUses}
                  onChange={(e) => update('maxUses', e.target.value)}
                />
                {errors.maxUses ? (
                  <div className={styles.fieldError}>{errors.maxUses}</div>
                ) : (
                  <p className={styles.fieldHint}>How many sales it can make. One is usual.</p>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="expires">
                  Works for
                </label>
                <select
                  id="expires"
                  className={styles.select}
                  value={form.expiresInDays}
                  onChange={(e) => update('expiresInDays', Number(e.target.value))}
                >
                  {EXPIRY_CHOICES.map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Credit</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="rep">
                  Rep
                </label>
                <select
                  id="rep"
                  className={styles.select}
                  value={form.rep}
                  onChange={(e) => update('rep', e.target.value)}
                >
                  {repChoices.map((r) => (
                    <option key={r} value={r}>
                      {r}
                      {r === me ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
                <p className={styles.fieldHint}>A sale with this code is credited to this rep.</p>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="note">
                  Note
                </label>
                <textarea
                  id="note"
                  className={styles.textArea}
                  maxLength={500}
                  placeholder="Who it is for, where you met them (only staff see this)"
                  value={form.note}
                  onChange={(e) => update('note', e.target.value)}
                />
              </div>
            </div>
          </div>
        </section>

        {serverError && (
          <p className={styles.formError} role="alert">
            {serverError}
          </p>
        )}
        <div className={styles.formActions}>
          <div className={styles.formActionsSpacer} />
          <Link to={consolePath('/admin/sales-codes')} className={`${styles.btn} ${styles.btnGhost}`}>
            Cancel
          </Link>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving}>
            {saving ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CustomerNotice() {
  return (
    <div className={styles.pageNarrow}>
      <div className={styles.panel}>
        <div className={styles.panelBody}>
          <p className={styles.quiet}>Sales codes are created by the Circuit Center team.</p>
        </div>
      </div>
    </div>
  );
}

export default function NewSalesCodePage() {
  const { isCustomer } = useAuth();
  return isCustomer ? <CustomerNotice /> : <StaffNewSalesCodePage />;
}
