// Manufacturer detail — the two-column supplier-detail layout, plus the two
// surfaces that only exist for manufacturers:
//
//   MERGE REVIEW  the human half of the auto-merge boundary. `approve`
//                 repoints every Part row onto the winner and may DELETE the
//                 losing manufacturer, so each decision is armed and states
//                 its consequence before it commits. A bare one-click Approve
//                 beside a one-click Reject would make an irreversible data
//                 migration read like dismissing a notification.
//
//   SUPPLIER      the bridge into the sponsorship machinery. A manufacturer is
//                 a company we know about; a Supplier is a company that can
//                 hold a placement. Promote creates the second from the first
//                 and links them — and when the name is already taken, the
//                 only correct move is to LINK the existing row, never to mint
//                 a duplicate company. That fork lives in ../supplierLink.ts.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Pencil } from 'lucide-react';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { setPrefill } from '@admin/services/prefillBus';
import type { AdminSupplier } from '@admin/types/admin';
import type { AdminManufacturerDetail, MergeCandidate } from '@admin/types/manufacturers';
import { safeHttpUrl } from '@shared/utils/url';

import { coverageLabel, promoteBlockedReason, promoteFailure } from '../supplierLink';
import styles from './ManufacturerDetail.module.scss';

type Armed = { id: string; action: 'approve' | 'reject' } | null;

const SOURCE_CLASS: Record<string, string> = {
  csv: styles.sourceCsv,
  catalog: styles.sourceCatalog,
  manual: styles.sourceManual,
};

const CONFIDENCE_CLASS: Record<string, string> = {
  approved: styles.confApproved,
  high: styles.confHigh,
  low: styles.confLow,
};

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function armCopy(action: 'approve' | 'reject', alias: string): string {
  return action === 'approve'
    ? `Merge "${alias}" into this manufacturer? Its parts re-point here and the duplicate row is retired. This cannot be undone from the console.`
    : `Dismiss "${alias}"? It stays a separate manufacturer and this suggestion will not come back.`;
}

export default function ManufacturerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<AdminManufacturerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Bumped after every write so the page re-reads the server's truth. Never
  // spliced locally: approve also recomputes catalog_part_count and can absorb
  // the loser's aliases, so local surgery would show pre-merge numbers.
  const [nonce, setNonce] = useState(0);

  const [armed, setArmed] = useState<Armed>(null);
  const [busyCandidate, setBusyCandidate] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState('');

  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [pickedSupplier, setPickedSupplier] = useState('');
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    adminApi
      .getManufacturer(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[ManufacturerDetail] load failed', err);
        setError(apiErrorDetail(err) ?? 'Failed to load this manufacturer.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  // Picker options, loaded only when the name-collision 409 actually opens it.
  // Best-effort: a failure costs the picker, never the page.
  const loadSuppliers = useCallback((preferName: string) => {
    adminApi
      .getSuppliers()
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setSuppliers(sorted);
        // The 409 means a supplier already owns this exact name — preselect it
        // so the obvious link is one click, not a scroll through 57 options.
        const exact = sorted.find(
          (s) => s.name.trim().toLowerCase() === preferName.trim().toLowerCase(),
        );
        setPickedSupplier(exact?.id ?? sorted[0]?.id ?? '');
      })
      .catch((err) => {
        console.warn('[ManufacturerDetail] getSuppliers failed', err);
        setSuppliers([]);
      });
  }, []);

  async function handleResolve(candidateId: string, action: 'approve' | 'reject') {
    setBusyCandidate(candidateId);
    setMergeError('');
    try {
      await adminApi.resolveMergeCandidate(candidateId, action);
      setArmed(null);
      setNonce((n) => n + 1);
    } catch (err) {
      console.error('[ManufacturerDetail] resolveMergeCandidate failed', err);
      setMergeError(
        apiErrorDetail(err) ??
          'Could not record that decision. The candidate may already have been resolved elsewhere.',
      );
    } finally {
      setBusyCandidate(null);
    }
  }

  async function handlePromote() {
    if (!id || !detail) return;
    setPromoting(true);
    setPromoteError('');
    try {
      await adminApi.promoteManufacturerToSupplier(id);
      setNonce((n) => n + 1);
    } catch (err) {
      console.error('[ManufacturerDetail] promote failed', err);
      const outcome = promoteFailure(apiErrorDetail(err));
      setPromoteError(outcome.message);
      if (outcome.showPicker) {
        setShowPicker(true);
        loadSuppliers(detail.name);
      }
    } finally {
      setPromoting(false);
    }
  }

  async function handleLink() {
    if (!id || !pickedSupplier) return;
    setLinking(true);
    setPromoteError('');
    try {
      await adminApi.linkManufacturerSupplier(id, pickedSupplier);
      setShowPicker(false);
      setNonce((n) => n + 1);
    } catch (err) {
      console.error('[ManufacturerDetail] link failed', err);
      setPromoteError(promoteFailure(apiErrorDetail(err)).message);
    } finally {
      setLinking(false);
    }
  }

  function handleSponsor() {
    if (!detail?.linked_supplier_id) return;
    setPrefill('sponsor', {
      supplier_id: detail.linked_supplier_id,
      supplier_name: detail.linked_supplier_name ?? detail.name,
    });
    navigate('/admin/sponsors/new');
  }

  if (loading) {
    return <div className={styles.loading}>Loading manufacturer&hellip;</div>;
  }

  if (error || !detail) {
    return (
      <div className={styles.page}>
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: '/admin' },
            { label: 'Manufacturers', href: '/admin/manufacturers' },
            { label: 'Error' },
          ]}
        />
        <div className={styles.errorPanel}>{error || 'Manufacturer not found.'}</div>
      </div>
    );
  }

  const site = detail.website ? safeHttpUrl(detail.website) : null;
  const pending: MergeCandidate[] = detail.merge_candidates;
  const blockedReason = promoteBlockedReason(detail);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/admin' },
          { label: 'Manufacturers', href: '/admin/manufacturers' },
          { label: detail.name },
        ]}
      />

      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <button
            type="button"
            className={styles.backLink}
            onClick={() => navigate('/admin/manufacturers')}
          >
            <ArrowLeft size={14} strokeWidth={2} />
            All manufacturers
          </button>
          <h1 className={styles.title}>{detail.name}</h1>
          <div className={styles.subtitle}>
            <span className={`${styles.sourceChip} ${SOURCE_CLASS[detail.source] ?? ''}`}>
              {detail.source}
            </span>
            {detail.website && (
              <>
                <span aria-hidden="true">&middot;</span>
                {site ? (
                  <a
                    href={site}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.extLink}
                  >
                    {stripScheme(detail.website)}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                ) : (
                  // safeHttpUrl refused the stored value — show it, never link it.
                  <span className={styles.mono}>{stripScheme(detail.website)}</span>
                )}
              </>
            )}
            <span aria-hidden="true">&middot;</span>
            <span className={styles.coverage}>
              {coverageLabel(detail.catalog_part_count, detail.external_part_count)}
            </span>
          </div>
        </div>
        <div className={styles.pageHeadActions}>
          <Link
            to={`/admin/manufacturers/${detail.id}/edit`}
            className={`${styles.btn} ${styles.btnGhost}`}
          >
            <Pencil size={14} strokeWidth={2} />
            Edit
          </Link>
        </div>
      </div>

      <div className={styles.detailGrid}>
        <div className={styles.mainStack}>
          {/* ─── Company ─────────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h3 className={styles.panelTitle}>Company</h3>
            </div>
            <dl className={styles.kvList}>
              <div>
                <dt>Website</dt>
                <dd className={styles.mono}>
                  {detail.website ? stripScheme(detail.website) : '—'}
                </dd>
              </div>
              <div>
                <dt>Canonical key</dt>
                {/* The merge arbiter: two spellings that canon() to the same
                    key are the same company. Shown verbatim so a bad merge can
                    be diagnosed from this page. */}
                <dd className={styles.mono}>{detail.canonical_key}</dd>
              </div>
              <div>
                <dt>Slug</dt>
                <dd className={styles.mono}>{detail.slug}</dd>
              </div>
              <div>
                <dt>Catalog parts</dt>
                <dd className={styles.mono}>
                  {detail.catalog_part_count.toLocaleString('en-US')}
                </dd>
              </div>
              <div>
                <dt>External coverage</dt>
                <dd>
                  {coverageLabel(detail.catalog_part_count, detail.external_part_count)}
                  {detail.external_part_count_as_of && (
                    <span className={styles.asOf}>
                      {' '}
                      &mdash; snapshot {detail.external_part_count_as_of.slice(0, 10)}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            {detail.description && (
              <div className={styles.panelBody}>
                <h4 className={styles.panelSubtitle}>Description</h4>
                <p className={styles.panelText}>{detail.description}</p>
              </div>
            )}
          </section>

          {/* ─── Merge review ────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h3 className={styles.panelTitle}>Merge review</h3>
              {pending.length > 0 && (
                <span className={styles.pendingCount}>
                  {pending.length} pending
                </span>
              )}
            </div>
            {pending.length === 0 ? (
              <div className={styles.panelEmpty}>
                No spellings are waiting on a decision.
              </div>
            ) : (
              <>
                <p className={styles.panelLede}>
                  Each row is a spelling the importer believes is this same company. Approving
                  re-points its parts here and retires the duplicate row.
                </p>
                {mergeError && <div className={styles.inlineError}>{mergeError}</div>}
                <ul className={styles.candidateList}>
                  {pending.map((c) => {
                    // `armed && armed.id === c.id` (not `armed?.id === c.id`):
                    // the optional-chain form does not narrow `armed` away
                    // from null for the branch below.
                    const armedAction = armed && armed.id === c.id ? armed.action : null;
                    const busy = busyCandidate === c.id;
                    return (
                      <li key={c.id} className={styles.candidate}>
                        <div className={styles.candidateTop}>
                          <span className={styles.candidateAlias}>{c.right_alias}</span>
                          <span className={styles.ruleChip}>{c.rule}</span>
                        </div>
                        {c.evidence && <p className={styles.evidence}>{c.evidence}</p>}
                        {armedAction ? (
                          <div className={styles.armStrip} aria-live="polite">
                            <p className={styles.armCopy}>{armCopy(armedAction, c.right_alias)}</p>
                            <div className={styles.candidateActions}>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${armedAction === 'approve' ? styles.btnPrimary : styles.btnDangerGhost}`}
                                disabled={busy}
                                onClick={() => handleResolve(c.id, armedAction)}
                              >
                                {busy
                                  ? 'Working…'
                                  : armedAction === 'approve'
                                    ? 'Yes, merge them'
                                    : 'Yes, dismiss it'}
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
                                disabled={busy}
                                onClick={() => setArmed(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className={styles.candidateActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
                              onClick={() => {
                                setMergeError('');
                                setArmed({ id: c.id, action: 'approve' });
                              }}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnDangerGhost}`}
                              onClick={() => {
                                setMergeError('');
                                setArmed({ id: c.id, action: 'reject' });
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          {/* ─── Aliases ─────────────────────────────────────────────────── */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h3 className={styles.panelTitle}>Aliases ({detail.aliases.length})</h3>
            </div>
            {detail.aliases.length === 0 ? (
              <div className={styles.panelEmpty}>No alternate spellings recorded.</div>
            ) : (
              <ul className={styles.aliasList}>
                {detail.aliases.map((a) => (
                  <li key={`${a.alias}-${a.source}`} className={styles.aliasRow}>
                    <span className={styles.aliasName}>{a.alias}</span>
                    <span className={styles.aliasMeta}>
                      <span className={styles.metaChip}>{a.source}</span>
                      <span
                        className={`${styles.metaChip} ${CONFIDENCE_CLASS[a.confidence] ?? ''}`}
                      >
                        {a.confidence}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ─── Supplier bridge ───────────────────────────────────────────── */}
        <div className={styles.sidebarStack}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h3 className={styles.panelTitle}>Supplier</h3>
            </div>
            {detail.linked_supplier_id ? (
              <div className={styles.panelBody}>
                <Link
                  to={`/admin/suppliers/${detail.linked_supplier_id}`}
                  className={styles.supplierLink}
                >
                  {detail.linked_supplier_name ?? 'Linked supplier'}
                </Link>
                <p className={styles.panelHint}>
                  Placements are sold against this supplier record.
                </p>

                <h4 className={styles.panelSubtitle}>Sponsorships</h4>
                {detail.linked_supplier_sponsorships.length === 0 ? (
                  <p className={styles.panelText}>None yet.</p>
                ) : (
                  <ul className={styles.sponsorList}>
                    {detail.linked_supplier_sponsorships.map((sp) => (
                      <li key={sp.id}>
                        <Link to={`/admin/sponsors/${sp.id}/edit`} className={styles.sponsorRow}>
                          <span className={styles.sponsorTier}>{sp.tier}</span>
                          {/* A NULL status is Active — legacy seed rows omit it,
                              and every read site in this codebase treats the
                              absence as live. Printing "—" here would suggest a
                              placement that isn't running. */}
                          <span className={styles.sponsorStatus}>{sp.status ?? 'Active'}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
                  onClick={handleSponsor}
                >
                  Sponsor this company &rarr;
                </button>
              </div>
            ) : (
              <div className={styles.panelBody}>
                <p className={styles.panelText}>
                  Not linked to a supplier yet. A manufacturer is a company we know about; only a
                  supplier can hold a paid placement.
                </p>
                {promoteError && <div className={styles.inlineError}>{promoteError}</div>}
                {blockedReason ? (
                  <p className={styles.panelHint}>{blockedReason}</p>
                ) : (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
                    disabled={promoting}
                    onClick={handlePromote}
                  >
                    {promoting ? 'Promoting…' : 'Promote to supplier'}
                  </button>
                )}

                {showPicker && (
                  <div className={styles.picker}>
                    <label className={styles.pickerLabel} htmlFor="mfr-link-supplier">
                      Link to an existing supplier
                    </label>
                    <select
                      id="mfr-link-supplier"
                      className={styles.select}
                      value={pickedSupplier}
                      onChange={(e) => setPickedSupplier(e.target.value)}
                    >
                      {suppliers.length === 0 && <option value="">No suppliers loaded</option>}
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
                      disabled={linking || !pickedSupplier}
                      onClick={handleLink}
                    >
                      {linking ? 'Linking…' : 'Link this supplier'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Parts in catalog</div>
            <div className={styles.miniStatValue}>
              {detail.catalog_part_count.toLocaleString('en-US')}
            </div>
            <div className={styles.miniStatHint}>
              {detail.external_part_count != null && detail.external_part_count > 0
                ? coverageLabel(detail.catalog_part_count, detail.external_part_count)
                : 'No external snapshot on file'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
