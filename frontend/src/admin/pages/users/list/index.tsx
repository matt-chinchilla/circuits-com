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

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { countryName, flagEmoji } from '@admin/services/country';
import type { AdminUser } from '@admin/types/users';
import { displayHost, safeHttpUrl } from '@shared/utils/url';

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
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Per-row, so two toggles in flight never disable each other's switch.
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  const [saveError, setSaveError] = useState('');

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

  // Optimistic with rollback. The rollback restores THIS ROW's captured value
  // rather than the whole array, so a second toggle finishing in between is
  // not stomped by the first one's failure.
  const handleActivate = (user: AdminUser, next: boolean) => {
    if (savingIds.includes(user.id)) return;
    setSaveError('');
    setSavingIds((cur) => [...cur, user.id]);
    const patchRow = (fresh: AdminUser) =>
      setRows((cur) => cur?.map((r) => (r.id === fresh.id ? fresh : r)) ?? cur);
    patchRow({ ...user, activated_at: next ? new Date().toISOString() : null });

    adminApi
      .updateUser(user.id, { activated: next })
      .then(patchRow)
      .catch((err) => {
        patchRow(user);
        setSaveError(
          apiErrorDetail(err) ??
            `Could not ${next ? 'activate' : 'deactivate'} ${user.full_name}. Nothing was changed.`,
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
                <th className={styles.actionHead}>Activate</th>
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
                  return (
                    <tr key={u.id} className={activated ? undefined : styles.rowWaiting}>
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
                        {u.supplier_id != null ? (
                          <Link
                            to={`/admin/suppliers/${u.supplier_id}`}
                            className={styles.supplierLink}
                          >
                            {u.company ?? 'Linked supplier'}
                          </Link>
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>
                      <td className={styles.actionCell}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={activated}
                          aria-label={`Account activation for ${u.full_name}`}
                          disabled={saving}
                          className={`${styles.pill} ${activated ? styles.pillOn : ''}`}
                          onClick={() => handleActivate(u, !activated)}
                        >
                          <span className={styles.knob} />
                        </button>
                      </td>
                    </tr>
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
