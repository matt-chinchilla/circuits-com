// Users — the registered-account roster.
//
// The one page that answers "who signed up, and who is still waiting?".
// Signup (Task 12) creates an account that can verify its address and sign in,
// but an UNACTIVATED account is refused by every /api/account route until a
// human here flips the switch. That makes this table an inbox, not an archive:
// the server returns unactivated accounts FIRST and the page must not re-sort
// them into created-desc and undo it.
//
// Everything is server-side truth read once. There is no paging, filtering or
// client comparator — at launch this is tens of rows, and inventing controls
// for data that fits on one screen is how a roster becomes a spreadsheet.
//
// Two cells are honest about their provenance rather than pretty:
//   Location — `signup_country`, stamped from the sign-up IP via the DB-IP
//     database. Never re-derivable later (the IP is not kept), so a null row
//     stays null forever, and the CC-BY attribution line below the table is a
//     licence requirement, not decoration.
//   Website  — read off the LINKED SUPPLIER, so it is an em dash for every
//     unlinked account. That is most rows at launch, and it is correct.
//
// The Company cell is also where the account is LINKED to its company, because
// tier is derived from the linked supplier's active sponsorship: with only the
// Activate toggle this page shipped with, no account could ever leave `free`.
// Two independent links (distributor and manufacturer) — see companyLinks.ts.

import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { useAuth } from '@admin/contexts/AuthContext';
import { isOwner } from '@admin/services/permissions';
import { activationControl } from './activationControl';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { countryName, flagEmoji } from '@admin/services/country';
import type { AdminSupplier } from '@admin/types/admin';
import type { AdminUser } from '@admin/types/users';
import { displayHost, safeHttpUrl } from '@shared/utils/url';

import CompanyLinkEditor from './CompanyLinkEditor';
import { manufacturerIdsToResolve } from './companyLinks';
import styles from './UsersListPage.module.scss';

const COLUMN_COUNT = 9;
const SKELETON_INDEXES = [0, 1, 2, 3, 4, 5];

// Record<string, …> rather than Record<AdminUser['tier'], …>: the union is a
// TypeScript claim about a runtime JSON string, so an unmapped tier must fall
// through to the neutral chip instead of an undefined class name.
const TIER_CLASS: Record<string, string> = {
  free: styles.tierFree,
  silver: styles.tierSilver,
  gold: styles.tierGold,
  platinum: styles.tierPlatinum,
};

// en-US rather than the ambient locale: this is a single-tenant US console,
// and a locale-dependent label is a locale-dependent test.
function formatDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function UsersListPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { user: viewer } = useAuth();
  const viewerIsOwner = isOwner(viewer);
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Per-row, so two toggles in flight never disable each other's switch.
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  // Which row is one click away from deletion. Null when nothing is armed.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  // The company-link pickers. One row edits at a time: the manufacturer picker
  // is a live search, and N of them open at once is N debounced request
  // streams against a rate-limited console for no benefit.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<readonly AdminSupplier[]>([]);
  const [suppliersFailed, setSuppliersFailed] = useState(false);
  // manufacturer id → name. The roster carries the id but no name (the server
  // joins the supplier only), so the handful that ARE linked are looked up.
  const [mfrNames, setMfrNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminApi
      .getUsers()
      .then((res) => {
        if (cancelled) return;
        // Stored in the order the server sent: unactivated first, then newest.
        setRows(res);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[UsersListPage] load failed', err);
        setError(apiErrorDetail(err) ?? 'Failed to load registered accounts.');
        setRows(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The distributor picker's options. Best-effort: a failure costs the picker,
  // never the roster — the editor says so rather than showing an empty select
  // that looks like "no suppliers exist".
  useEffect(() => {
    let cancelled = false;
    adminApi
      .getSuppliers()
      .then((res) => {
        if (cancelled) return;
        setSuppliers([...res].sort((a, b) => a.name.localeCompare(b.name)));
        setSuppliersFailed(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[UsersListPage] getSuppliers failed', err);
        setSuppliers([]);
        setSuppliersFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Names for the manufacturer ids already on the roster. Distinct ids only,
  // and at launch this loop runs zero times.
  useEffect(() => {
    if (!rows) return undefined;
    const ids = manufacturerIdsToResolve(rows).filter((id) => !(id in mfrNames));
    if (ids.length === 0) return undefined;
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        adminApi
          .getManufacturer(id)
          .then((m) => [id, m.name] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const found = pairs.filter((p): p is readonly [string, string] => p !== null);
      if (found.length === 0) return;
      setMfrNames((cur) => ({ ...cur, ...Object.fromEntries(found) }));
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `rows` alone: mfrNames is READ here to skip ids
    // already resolved and WRITTEN on resolve, so depending on it would re-run
    // the effect on its own result. The `ids` filter is what makes the
    // omission safe — a second pass would find nothing left to fetch.
  }, [rows]);

  const patchRow = (fresh: AdminUser) =>
    setRows((cur) => cur?.map((r) => (r.id === fresh.id ? fresh : r)) ?? cur);

  // Optimistic with rollback. The rollback restores THIS ROW's captured value
  // rather than the whole array, so a second toggle finishing in between is
  // not stomped by the first one's failure.
  // Activation only ever goes one way — the server answers 409
  // `activation_is_one_way` to anything else, so there is no `next` argument to
  // get wrong here.
  const handleActivate = (user: AdminUser) => {
    if (savingIds.includes(user.id)) return;
    setSaveError('');
    setSavingIds((cur) => [...cur, user.id]);
    // No optimistic activated_at stamp: flipping it before the PATCH resolves
    // swapped the control into its post-activation branch mid-flight, so the
    // owner pressing Activate watched the button read "Deleting…". The row
    // updates from the server's response, which is the stamp that counts.
    adminApi
      .updateUser(user.id, { activated: true })
      .then(patchRow)
      .catch((err) => {
        setSaveError(
          apiErrorDetail(err) ??
            `Could not activate ${user.full_name}. Nothing was changed.`,
        );
      })
      .finally(() => {
        setSavingIds((cur) => cur.filter((id) => id !== user.id));
      });
  };

  // Two-step, in place. Deleting a customer removes their login and their own
  // inbox, so a single stray click should not do it — and a native confirm()
  // would block the page, which this codebase avoids.
  const handleDelete = (user: AdminUser) => {
    if (savingIds.includes(user.id)) return;
    if (confirmingId !== user.id) {
      setConfirmingId(user.id);
      return;
    }
    setConfirmingId(null);
    setSaveError('');
    setSavingIds((cur) => [...cur, user.id]);
    adminApi
      .deleteUser(user.id)
      .then(() => setRows((cur) => cur?.filter((r) => r.id !== user.id) ?? cur))
      .catch((err) => {
        setSaveError(
          apiErrorDetail(err) ??
            `Could not delete ${user.full_name}. Nothing was changed.`,
        );
      })
      .finally(() => {
        setSavingIds((cur) => cur.filter((id) => id !== user.id));
      });
  };

  const list = rows ?? [];
  const waiting = list.filter((u) => u.activated_at == null).length;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Users</h1>
          <p className={styles.subtitle}>
            Everyone who registered for an account &mdash; unactivated first, because they are
            the ones waiting on us.
          </p>
        </div>
        {!loading && list.length > 0 && (
          <div className={styles.counts}>
            <span className={waiting > 0 ? styles.countWaiting : styles.countClear}>
              {waiting === 0
                ? 'Nobody waiting'
                : `${waiting} waiting for activation`}
            </span>
            <span className={styles.countTotal}>
              {list.length.toLocaleString('en-US')} registered
            </span>
          </div>
        )}
      </header>

      {saveError && (
        <p className={styles.saveError} role="status">
          {saveError}
        </p>
      )}

      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Member Since</th>
                <th>Location</th>
                <th>Website</th>
                <th>Tier</th>
                <th>Verified</th>
                <th>Company</th>
                <th className={styles.actionHead}>Access</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                SKELETON_INDEXES.map((i) => (
                  <tr key={`skel-${i}`} className={styles.skelRow} aria-hidden="true">
                    <td>
                      <span className={`${styles.skel} ${styles.skelWide}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelWide}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelChip}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelChip}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelSwitch}`} />
                    </td>
                  </tr>
                ))}

              {!loading &&
                list.map((u) => {
                  const activated = u.activated_at != null;
                  const saving = savingIds.includes(u.id);
                  const site = u.website ? safeHttpUrl(u.website) : null;
                  const verifiedOn = formatDay(u.email_verified_at);
                  const country = u.signup_country ?? null;
                  const editing = editingId === u.id;
                  const mfrName = u.manufacturer_id
                    ? (mfrNames[u.manufacturer_id] ?? 'Linked manufacturer')
                    : null;
                  const linked = u.supplier_id != null || u.manufacturer_id != null;
                  return (
                    <Fragment key={u.id}>
                      <tr className={activated ? undefined : styles.rowWaiting}>
                        <td className={styles.nameCell}>{u.full_name}</td>
                        <td className={styles.emailCell}>
                          <a href={`mailto:${u.email}`} className={styles.emailLink}>
                            {u.email}
                          </a>
                        </td>
                        <td className={styles.dateCell}>{formatDay(u.created_at) ?? '\u2014'}</td>
                        <td className={styles.locationCell}>
                          {country ? (
                            <>
                              <span aria-hidden="true">{flagEmoji(country)}</span>{' '}
                              {countryName(country)}
                            </>
                          ) : (
                            <span className={styles.muted}>&mdash;</span>
                          )}
                        </td>
                        <td className={styles.siteCell}>
                          {site ? (
                            <a
                              href={site}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.siteLink}
                            >
                              {displayHost(site) ?? site}
                            </a>
                          ) : (
                            // No linked supplier (most rows at launch), or a
                            // stored value safeHttpUrl refused. Never clickable.
                            <span className={styles.muted}>&mdash;</span>
                          )}
                        </td>
                        <td>
                          <span className={`${styles.tierChip} ${TIER_CLASS[u.tier] ?? ''}`}>
                            {u.tier}
                          </span>
                        </td>
                        <td>
                          {verifiedOn ? (
                            <span
                              className={`${styles.stateChip} ${styles.stateOk}`}
                              title={`Email confirmed ${verifiedOn}`}
                            >
                              Verified
                            </span>
                          ) : (
                            <span className={`${styles.stateChip} ${styles.statePending}`}>
                              Unverified
                            </span>
                          )}
                        </td>
                        <td className={styles.companyCell}>
                          <div className={styles.linkStack}>
                            {/* Two links, shown separately: an account may be a
                                distributor, a manufacturer, or both. */}
                            {u.supplier_id != null && (
                              <span className={styles.linkLine}>
                                <span className={styles.linkKind}>Dist.</span>
                                <Link
                                  to={consolePath(`/admin/suppliers/${u.supplier_id}`)}
                                  className={styles.supplierLink}
                                >
                                  {u.company ?? 'Linked supplier'}
                                </Link>
                              </span>
                            )}
                            {mfrName && (
                              <span className={styles.linkLine}>
                                <span className={styles.linkKind}>Mfr.</span>
                                <Link
                                  to={consolePath(`/admin/manufacturers/${u.manufacturer_id}`)}
                                  className={styles.supplierLink}
                                >
                                  {mfrName}
                                </Link>
                              </span>
                            )}
                            {!linked && <span className={styles.muted}>&mdash;</span>}
                            <button
                              type="button"
                              className={styles.linkBtn}
                              aria-expanded={editing}
                              onClick={() => setEditingId(editing ? null : u.id)}
                            >
                              {editing ? 'Close' : linked ? 'Change company' : 'Link company'}
                            </button>
                          </div>
                        </td>
                        <td className={styles.actionCell}>
                          {(() => {
                            const control = activationControl({
                              activatedAt: u.activated_at,
                              viewerIsOwner,
                            });
                            if (control.kind === 'activate') {
                              return (
                                <button
                                  type="button"
                                  disabled={saving}
                                  className={`${styles.btn} ${styles.btnPrimary}`}
                                  onClick={() => handleActivate(u)}
                                >
                                  {saving ? 'Activating…' : 'Activate'}
                                </button>
                              );
                            }
                            if (control.kind === 'delete') {
                              const armed = confirmingId === u.id;
                              return (
                                <button
                                  type="button"
                                  disabled={saving}
                                  className={`${styles.btn} ${armed ? styles.btnDanger : styles.btnGhost}`}
                                  onClick={() => handleDelete(u)}
                                  onBlur={() => armed && setConfirmingId(null)}
                                  title={
                                    armed
                                      ? 'Removes their sign-in, their own messages, and their private expense and lead entries. Their company’s listings and any sponsorship keep running.'
                                      : undefined
                                  }
                                >
                                  {saving ? 'Deleting…' : armed ? 'Confirm delete' : 'Delete'}
                                </button>
                              );
                            }
                            // Activated, and the viewer is not the owner — DELETE
                            // is require_owner, so there is nothing to offer.
                            return <span className={styles.activatedTag}>Activated</span>;
                          })()}
                        </td>
                      </tr>
                      {editing && (
                        <tr className={styles.editorRow}>
                          <td colSpan={COLUMN_COUNT}>
                            <CompanyLinkEditor
                              user={u}
                              suppliers={suppliers}
                              suppliersFailed={suppliersFailed}
                              manufacturerName={mfrName}
                              onCancel={() => setEditingId(null)}
                              onSaved={(fresh, savedManufacturerName) => {
                                patchRow(fresh);
                                // Keep the name beside the id the server just
                                // confirmed — without it the row would fall back
                                // to 'Linked manufacturer' until a reload.
                                const savedId = fresh.manufacturer_id;
                                if (savedId && savedManufacturerName) {
                                  setMfrNames((cur) => ({
                                    ...cur,
                                    [savedId]: savedManufacturerName,
                                  }));
                                }
                                setEditingId(null);
                                setSaveError('');
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

              {!loading && list.length === 0 && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className={styles.emptyRow}>
                    {error ? error : 'No registered accounts yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CC-BY licence requirement for the DB-IP Lite database behind the
          Location column — the same line the Reports map carries. */}
      <p className={styles.attribution}>
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
          IP geolocation by DB-IP (CC BY 4.0)
        </a>
      </p>
    </div>
  );
}
