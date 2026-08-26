// The company-link editor for one roster row.
//
// Two INDEPENDENT controls, never a choice between two: an account may be a
// distributor, a manufacturer, or both (Avnet is both), and the save sends
// whichever of the two actually moved.
//
// The two pickers are shaped differently on purpose. There are ~57 suppliers,
// so that one is a plain <select> holding all of them. There are ~2,450
// manufacturers, so that one is a search box over GET /api/admin/manufacturers
// (`q`, eight rows at a time) — 2,450 <option> nodes per row is not a picker,
// it is a scroll.
import { useEffect, useRef, useState } from 'react';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { AdminSupplier } from '@admin/types/admin';
import type { AdminManufacturer } from '@admin/types/manufacturers';
import type { AdminUser } from '@admin/types/users';

import { buildLinkPatch, currentLinks, hasLinkChanges } from './companyLinks';
import styles from './UsersListPage.module.scss';

/** Below this the search matches most of the table, so it does not run. */
const MIN_QUERY = 2;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_ROWS = 8;

interface PickedManufacturer {
  id: string;
  name: string;
}

interface Props {
  user: AdminUser;
  suppliers: readonly AdminSupplier[];
  suppliersFailed: boolean;
  /** The name behind `user.manufacturer_id`, when the page resolved one. */
  manufacturerName: string | null;
  onCancel: () => void;
  /** The row the server sent back, plus the manufacturer name to display. */
  onSaved: (fresh: AdminUser, manufacturerName: string | null) => void;
}

export default function CompanyLinkEditor({
  user,
  suppliers,
  suppliersFailed,
  manufacturerName,
  onCancel,
  onSaved,
}: Props) {
  const [supplierId, setSupplierId] = useState<string>(user.supplier_id ?? '');
  const [manufacturer, setManufacturer] = useState<PickedManufacturer | null>(
    user.manufacturer_id ? { id: user.manufacturer_id, name: manufacturerName ?? 'Linked manufacturer' } : null,
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminManufacturer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // Debounced manufacturer search. The cancel flag guards BOTH the timer and
  // the response, so a fast typist never sees an earlier query's rows land on
  // top of a later one's.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      adminApi
        .getManufacturers({ q, per_page: SEARCH_ROWS, page: 1 })
        .then((res) => {
          if (cancelled) return;
          setResults(res.manufacturers);
          setSearchFailed(false);
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn('[CompanyLinkEditor] manufacturer search failed', err);
          setResults([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const patch = buildLinkPatch(currentLinks(user), {
    supplier_id: supplierId,
    manufacturer_id: manufacturer?.id ?? null,
  });
  const dirty = hasLinkChanges(patch);

  const handleSave = () => {
    if (saving) return;
    if (!dirty) {
      onCancel();
      return;
    }
    setSaving(true);
    setError('');
    adminApi
      .updateUser(user.id, patch)
      .then((fresh) => onSaved(fresh, manufacturer?.name ?? null))
      .catch((err) => {
        console.error('[CompanyLinkEditor] link save failed', err);
        setError(
          apiErrorDetail(err) ??
            `Could not update the company links for ${user.full_name}. Nothing was changed.`,
        );
        setSaving(false);
      });
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorHead}>
        <span className={styles.editorTitle}>Company links &mdash; {user.full_name}</span>
        <span className={styles.editorHint}>
          Set either or <strong>both</strong>. A company that distributes and manufactures holds
          both links; the tier follows the linked supplier&rsquo;s active sponsorship.
        </span>
      </div>

      <div className={styles.editorFields}>
        <div className={styles.editorField}>
          <label className={styles.editorLabel} htmlFor={`sup-${user.id}`}>
            Distributor (supplier)
          </label>
          <select
            id={`sup-${user.id}`}
            ref={firstFieldRef}
            className={styles.select}
            value={supplierId}
            disabled={saving}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="">&mdash; not a distributor &mdash;</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {suppliersFailed && (
            <p className={styles.editorNote}>
              The supplier list didn&rsquo;t load, so this picker is empty. Reload to try again.
            </p>
          )}
        </div>

        <div className={styles.editorField}>
          <label className={styles.editorLabel} htmlFor={`mfr-${user.id}`}>
            Manufacturer
          </label>
          {manufacturer ? (
            <div className={styles.pickedRow}>
              <span className={styles.pickedName}>{manufacturer.name}</span>
              <button
                type="button"
                className={styles.linkBtn}
                disabled={saving}
                onClick={() => {
                  setManufacturer(null);
                  setQuery('');
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            <>
              <input
                id={`mfr-${user.id}`}
                type="text"
                className={styles.input}
                placeholder="Search manufacturers&hellip;"
                value={query}
                disabled={saving}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
              />
              {query.trim().length >= MIN_QUERY && (
                <div className={styles.results}>
                  {searching && <p className={styles.editorNote}>Searching&hellip;</p>}
                  {!searching && searchFailed && (
                    <p className={styles.editorNote}>
                      Search unavailable right now &mdash; nothing was changed.
                    </p>
                  )}
                  {!searching && !searchFailed && results.length === 0 && (
                    <p className={styles.editorNote}>No manufacturer matches that.</p>
                  )}
                  {!searching &&
                    results.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={styles.resultBtn}
                        onClick={() => {
                          setManufacturer({ id: m.id, name: m.name });
                          setQuery('');
                        }}
                      >
                        {m.name}
                      </button>
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <p className={styles.editorError} role="status">
          {error}
        </p>
      )}

      <div className={styles.editorActions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGhost}`}
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving || !dirty}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save links'}
        </button>
      </div>
    </div>
  );
}
