// Manufacturer create / edit.
//
// Three fields only. The catalog-derived numbers (catalog_part_count,
// external_part_count, canonical_key, aliases) are computed by the importer
// and the merge pipeline — a form that let an admin type over them would
// invent facts the rest of the system reasons about.
//
// `type="text"` + inputMode="url" + noValidate on the website field, never
// a url-typed input: an HTML5-invalid value in one makes the
// browser swallow submit entirely — React's onSubmit never fires, nothing is
// styled invalid, and nothing is logged. The check below is ours.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { ArrowLeft } from 'lucide-react';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { AdminManufacturer } from '@admin/types/manufacturers';
import { safeHttpUrl } from '@shared/utils/url';

import styles from './ManufacturerForm.module.scss';

// Mirrors the server's Pydantic bounds so a long paste fails here, in the
// field, instead of as an opaque 422 after a round trip.
const NAME_MAX = 200;
const WEBSITE_MAX = 300;

// The one machine code this form can provoke that apiErrorDetail doesn't
// already translate.
const SAVE_MESSAGES: Record<string, string> = {
  manufacturer_exists:
    'A manufacturer with this name already exists — open that row from the list instead of creating a second one.',
};

interface FormState {
  name: string;
  website: string;
  description: string;
}

interface FormErrors {
  name?: string;
  website?: string;
}

// Accepts "acme.com", "www.acme.com/parts", "https://acme.com" — rejects a bare
// word (no dot) and anything safeHttpUrl refuses (javascript:, data:, …).
function websiteError(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > WEBSITE_MAX) return `Keep this under ${WEBSITE_MAX} characters.`;
  if (!safeHttpUrl(value)) return 'That is not a usable web address.';
  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  if (!/^[^\s.]+(\.[^\s.]+)+$/.test(host)) return 'Enter a domain, e.g. acme.com';
  return undefined;
}

export default function ManufacturerFormPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormState>({ name: '', website: '', description: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEdit);
  const [existingName, setExistingName] = useState('');

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoadingExisting(true);
    adminApi
      .getManufacturer(id)
      .then((m) => {
        if (cancelled) return;
        setForm({
          name: m.name,
          website: m.website ?? '',
          description: m.description ?? '',
        });
        setExistingName(m.name);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[ManufacturerForm] load failed', err);
        setSaveError(apiErrorDetail(err) ?? 'Failed to load this manufacturer.');
      })
      .finally(() => {
        if (!cancelled) setLoadingExisting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    const name = form.name.trim();
    if (!name) next.name = 'A name is required.';
    else if (name.length > NAME_MAX) next.name = `Keep this under ${NAME_MAX} characters.`;
    const site = websiteError(form.website);
    if (site) next.website = site;
    return next;
  }

  async function handleSubmit() {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    setSaveError('');
    // Normalized on the way in so every read site gets an absolute http(s) URL
    // (safeHttpUrl already validated it above; null is unreachable here).
    const website = form.website.trim() ? safeHttpUrl(form.website.trim()) : null;
    const payload = {
      name: form.name.trim(),
      website,
      description: form.description.trim() || null,
    };

    try {
      if (isEdit && id) {
        await adminApi.updateManufacturer(id, payload);
        navigate(consolePath(`/admin/manufacturers/${id}`));
      } else {
        const created = (await adminApi.createManufacturer(payload)) as AdminManufacturer;
        // Straight to the new row's detail page: promote/link and merge review
        // all live there, and they are the reason a manufacturer gets typed in
        // by hand at all.
        if (created?.id) navigate(consolePath(`/admin/manufacturers/${created.id}`));
        else navigate(consolePath('/admin/manufacturers'));
      }
    } catch (err) {
      console.error('[ManufacturerForm] save failed', err);
      const detail = apiErrorDetail(err);
      setSaveError(
        (detail && SAVE_MESSAGES[detail]) ??
          detail ??
          'Failed to save this manufacturer. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isEdit && id) navigate(consolePath(`/admin/manufacturers/${id}`));
    else navigate(consolePath('/admin/manufacturers'));
  }

  if (loadingExisting) {
    return <div className={styles.loading}>Loading manufacturer&hellip;</div>;
  }

  const breadcrumbs = isEdit
    ? [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Manufacturers', href: '/admin/manufacturers' },
        { label: existingName || 'Manufacturer', href: `/admin/manufacturers/${id}` },
        { label: 'Edit' },
      ]
    : [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Manufacturers', href: '/admin/manufacturers' },
        { label: 'New Manufacturer' },
      ];

  return (
    <div className={styles.page}>
      <Breadcrumbs items={breadcrumbs} />

      <div className={styles.pageHead}>
        <button type="button" className={styles.backLink} onClick={handleCancel}>
          <ArrowLeft size={14} strokeWidth={2} />
          {isEdit ? 'Back to manufacturer' : 'Manufacturers'}
        </button>
        <h1 className={styles.title}>
          {isEdit ? `Edit ${existingName || 'Manufacturer'}` : 'New Manufacturer'}
        </h1>
        <p className={styles.subtitle}>
          {isEdit
            ? 'Update the company record behind this roster entry.'
            : 'Add a company by hand. Part counts and aliases stay with the importer.'}
        </p>
      </div>

      <form
        className={styles.formGrid}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Identity</h3>
          </header>
          <div className={styles.panelBody}>
            {saveError && <div className={styles.formError}>{saveError}</div>}

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="mfr-name">
                Company name <span className={styles.fieldReq}>*</span>
              </label>
              <input
                id="mfr-name"
                type="text"
                maxLength={NAME_MAX}
                className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Vishay Intertechnology"
              />
              {errors.name && <div className={styles.fieldError}>{errors.name}</div>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="mfr-website">
                Website
              </label>
              <input
                id="mfr-website"
                type="text"
                inputMode="url"
                autoComplete="off"
                maxLength={WEBSITE_MAX}
                className={`${styles.input} ${styles.inputMono} ${errors.website ? styles.inputError : ''}`}
                value={form.website}
                onChange={(e) => set('website', e.target.value)}
                placeholder="acme.com"
              />
              {errors.website ? (
                <div className={styles.fieldError}>{errors.website}</div>
              ) : (
                <div className={styles.fieldHint}>
                  Saved with an https:// prefix. Used for the outreach link on the roster.
                </div>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="mfr-desc">
                Description
              </label>
              <textarea
                id="mfr-desc"
                className={styles.textarea}
                rows={3}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What this company makes, in one line."
              />
              <div className={styles.fieldHint}>Internal note &mdash; not shown on the public site.</div>
            </div>
          </div>
        </section>

        <div className={styles.formActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={handleCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create manufacturer'}
          </button>
        </div>
      </form>
    </div>
  );
}
