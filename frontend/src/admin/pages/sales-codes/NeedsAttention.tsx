import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '@admin/services/adminApi';
import { useConsolePath } from '@admin/services/consolePath';
import { useAuth } from '@admin/contexts/AuthContext';
import ConfirmAction from '@admin/components/ConfirmAction';
import { formatDay } from '@admin/pages/sponsors/form/billingFormat';
import { normalizeAttention, type Attention, type ConflictRow, type HoldRow } from './salesCodes';
import styles from './SalesCodes.module.scss';

// Needs attention (spec §12): the three queues a rep must act on, at the top
// of the Sales codes page, and NOTHING when all three are empty — a strip
// that says "all clear" every day trains people to skip it.
//
//   Conflicts — a buyer paid for a slot they could not have (spec §8.3). The
//               sweep cancels + refunds hourly; Retry runs it now.
//   Holds     — a live checkout holding an exclusive slot. Release frees it.
//   Failing   — a sponsor whose card is failing; the link opens its billing.
//
// Any load failure (404 = Stripe unconfigured, 403 = view-only, a network
// error) also renders nothing: the codes table below reports the page state.

type Pending = { kind: 'resolve'; row: ConflictRow } | { kind: 'release'; row: HoldRow };

function timeOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function placeLine(tier: string, place: string): string {
  if (tier && place) return `${tier} on ${place}`;
  return tier || place || 'an exclusive slot';
}

export default function NeedsAttention() {
  const consolePath = useConsolePath();
  const { isReadOnly } = useAuth();
  const [data, setData] = useState<Attention | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    adminApi
      .getAttention()
      .then((raw) => {
        if (!cancelled) setData(normalizeAttention(raw));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(load, [load]);

  if (!data || data.total === 0) return null;

  return (
    <section className={styles.attention} aria-labelledby="attention-title">
      <div className={styles.attentionHead}>
        <h2 id="attention-title" className={styles.attentionTitle}>
          Needs attention
        </h2>
        <span className={styles.attentionCount}>{data.total}</span>
      </div>

      {data.conflicts.length > 0 && (
        <div className={styles.attentionGroup} data-kind="conflict">
          <h3 className={styles.attentionLabel}>Paid but not placed &mdash; refund due</h3>
          <ul className={styles.attentionList}>
            {data.conflicts.map((row) => (
              <li key={row.id} className={styles.attentionRow}>
                <span className={styles.attentionText}>
                  {row.company} paid for {placeLine(row.tier, row.place)}
                  <small>
                    {row.reason}
                    {row.at ? ` · ${formatDay(row.at)}` : ''}. The hourly sweep keeps retrying
                    the cancel and refund.
                  </small>
                </span>
                {!isReadOnly && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall} ${styles.attentionAction}`}
                    onClick={() => setPending({ kind: 'resolve', row })}
                  >
                    Refund now
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.holds.length > 0 && (
        <div className={styles.attentionGroup} data-kind="hold">
          <h3 className={styles.attentionLabel}>Checkouts holding a slot</h3>
          <ul className={styles.attentionList}>
            {data.holds.map((row) => (
              <li key={row.id} className={styles.attentionRow}>
                <span className={styles.attentionText}>
                  {row.company} is checking out {placeLine(row.tier, row.place)}
                  <small>
                    Held until {timeOf(row.until)}
                    {row.email ? ` · ${row.email}` : ''}
                  </small>
                </span>
                {!isReadOnly && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall} ${styles.attentionAction}`}
                    onClick={() => setPending({ kind: 'release', row })}
                  >
                    Release
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.failing.length > 0 && (
        <div className={styles.attentionGroup} data-kind="failing">
          <h3 className={styles.attentionLabel}>Payments failing</h3>
          <ul className={styles.attentionList}>
            {data.failing.map((row) => (
              <li key={row.sponsorId} className={styles.attentionRow}>
                <span className={styles.attentionText}>
                  {row.company}
                  {row.tier ? ` · ${placeLine(row.tier, row.place)}` : ''}
                  <small>
                    Failing since {formatDay(row.failingSince)} · cancels {formatDay(row.cancelsOn)}
                  </small>
                </span>
                <Link
                  to={consolePath(`/admin/sponsors/${row.sponsorId}/edit`)}
                  className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall} ${styles.attentionAction}`}
                >
                  Open billing
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending?.kind === 'resolve' && (
        <ConfirmAction
          tone="danger"
          title={`Cancel and refund ${pending.row.company}${
            pending.row.priceUsd != null ? `’s $${pending.row.priceUsd.toLocaleString('en-US')}/mo` : ''
          } payment?`}
          body={
            <p>
              Stripe cancels their subscription and refunds every invoice it paid. Running it again
              is safe &mdash; nothing is refunded twice.
            </p>
          }
          confirmLabel="Cancel and refund"
          busyLabel="Refunding…"
          onConfirm={async (key) => {
            await adminApi.resolveIntent(pending.row.id, key);
            setPending(null);
            load();
          }}
          onClose={() => setPending(null)}
        />
      )}

      {pending?.kind === 'release' && (
        <ConfirmAction
          title={`Release the hold on ${placeLine(pending.row.tier, pending.row.place)}?`}
          body={
            <p>
              {pending.row.company}&rsquo;s Stripe checkout is closed and the slot reopens for anyone.
              If they had already paid, the payment arrives as a conflict above and is refunded.
            </p>
          }
          confirmLabel="Release the slot"
          busyLabel="Releasing…"
          onConfirm={async (key) => {
            await adminApi.releaseIntent(pending.row.id, key);
            setPending(null);
            load();
          }}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}
