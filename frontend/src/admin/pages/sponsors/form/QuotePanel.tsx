import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  type QuoteLadderResponse,
  type SponsorQuote,
} from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import styles from './SponsorFormPage.module.scss';

// The Stripe billing panel on an EXISTING sponsorship: list the supplier's
// quotes, build a new one from the fixed all-in ladder, download the PDF,
// mark it accepted once the customer says yes. Rendered OUTSIDE the <form> —
// its buttons must never submit the sponsorship.
//
// Every price here is a FINAL monthly total (tax included): the number the
// rep picks is the number the customer pays, enforced server-side. The panel
// hides itself entirely when billing is unconfigured (the routes 404).

interface Props {
  sponsorId: string;
  tier: string;
}

const EMPTY_ADDRESS = { line1: '', line2: '', city: '', state: '', postal_code: '' };

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 ? 2 : 0,
  })}`;
}

export default function QuotePanel({ sponsorId, tier }: Props) {
  const tierKey = tier.trim().toLowerCase();

  const [ladder, setLadder] = useState<QuoteLadderResponse | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [quotes, setQuotes] = useState<SponsorQuote[]>([]);
  const [showModal, setShowModal] = useState(false);

  const [target, setTarget] = useState<number | null>(null);
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ quote_id: string; number: string | null } | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<string | null>(null);

  const refreshQuotes = useCallback(() => {
    let cancelled = false;
    adminApi
      .getSponsorQuotes(sponsorId)
      .then((rows) => {
        if (!cancelled) setQuotes(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sponsorId]);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .getQuoteLadder()
      .then((data) => {
        if (!cancelled) setLadder(data);
      })
      .catch(() => {
        // 404 = STRIPE_SECRET_KEY unset server-side: billing does not exist in
        // this environment. Transient failures land here too — hiding a panel
        // the rep can re-enter beats rendering a broken billing surface.
        if (!cancelled) setUnconfigured(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(refreshQuotes, [refreshQuotes]);

  if (unconfigured) return null;
  const steps = ladder?.tiers[tierKey]?.steps;

  const openModal = () => {
    setTarget(steps ? steps[0] : null);
    setAddress(EMPTY_ADDRESS);
    setError(null);
    setCreated(null);
    setShowModal(true);
  };

  const downloadPdf = async (quoteId: string) => {
    setRowBusy(quoteId);
    try {
      const blob = await adminApi.downloadQuotePdf(quoteId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quoteId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setRowNotice(apiErrorDetail(err) ?? 'PDF download failed — try again');
    } finally {
      setRowBusy(null);
    }
  };

  const accept = async (quoteId: string) => {
    setRowBusy(quoteId);
    setRowNotice(null);
    try {
      await adminApi.acceptQuote(quoteId);
      setRowNotice(
        'Accepted — Stripe has created the subscription and sent the first invoice. ' +
          'The placement goes Active when it is paid.'
      );
      refreshQuotes();
    } catch (err) {
      setRowNotice(apiErrorDetail(err) ?? 'Accept failed — try again');
    } finally {
      setRowBusy(null);
    }
  };

  const submit = async () => {
    if (target == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.createSponsorQuote(sponsorId, {
        monthly_total: target,
        address: {
          line1: address.line1,
          line2: address.line2 || undefined,
          city: address.city,
          state: address.state,
          postal_code: address.postal_code,
        },
      });
      setCreated({ quote_id: result.quote_id, number: result.number });
      refreshQuotes();
    } catch (err) {
      setError(apiErrorDetail(err) ?? 'Quote failed — nothing was sent');
    } finally {
      setBusy(false);
    }
  };

  const addressComplete =
    address.line1.trim() &&
    address.city.trim() &&
    address.state.trim().length === 2 &&
    address.postal_code.trim().length >= 5;

  return (
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Stripe billing</h2>
      </header>
      <div className={styles.panelBody}>
        {steps ? (
          <>
            <p className={styles.fieldHint}>
              Quotes use fixed all-in monthly prices — tax is included, so the number the
              customer sees is exactly what they pay.
            </p>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={openModal}>
              New quote
            </button>
          </>
        ) : (
          <p className={styles.fieldHint}>
            No quote ladder exists for the “{tier}” tier — quotes cover Platinum, Gold and
            Silver placements.
          </p>
        )}

        {quotes.length > 0 && (
          <ul className={styles.quoteList}>
            {quotes.map((q) => (
              <li key={q.quote_id} className={styles.quoteRow}>
                <span className={styles.quoteNumber}>{q.number ?? q.quote_id}</span>
                <span className={styles.quoteBadge} data-status={q.status}>
                  {q.status}
                </span>
                <span className={styles.quoteAmount}>{dollars(q.amount_total)}/mo all-in</span>
                <span className={styles.quoteActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    disabled={rowBusy === q.quote_id}
                    onClick={() => downloadPdf(q.quote_id)}
                  >
                    PDF
                  </button>
                  {q.status === 'open' && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={rowBusy === q.quote_id}
                      onClick={() => accept(q.quote_id)}
                    >
                      Customer accepted
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rowNotice && <p className={styles.fieldHint}>{rowNotice}</p>}
      </div>

      {showModal && steps && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            {created ? (
              <>
                <h3 className={styles.modalTitle}>Quote {created.number ?? created.quote_id} is ready</h3>
                <p className={styles.modalBody}>
                  Download the PDF and send it to the customer. When they say yes, use
                  “Customer accepted” on the quote below — Stripe then creates the
                  subscription and emails the first invoice.
                </p>
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => downloadPdf(created.quote_id)}
                  >
                    Download PDF
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    onClick={() => setShowModal(false)}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className={styles.modalTitle}>New quote — {tier}</h3>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="quote-price">
                    Monthly price (tax included)
                  </label>
                  <select
                    id="quote-price"
                    className={styles.select}
                    value={target ?? ''}
                    onChange={(e) => setTarget(Number(e.target.value))}
                  >
                    {steps.map((step, i) => (
                      <option key={step} value={step}>
                        {i === 0
                          ? `$${step.toLocaleString()} / mo — list price`
                          : `$${step.toLocaleString()} / mo — save $${(steps[0] - step).toLocaleString()}`}
                      </option>
                    ))}
                  </select>
                  <p className={styles.fieldHint}>
                    The customer pays exactly this amount. Stripe accounts for NY sales tax
                    inside it.
                  </p>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="quote-line1">
                    Customer billing address
                  </label>
                  <input
                    id="quote-line1"
                    type="text"
                    className={styles.textInput}
                    placeholder="Street address"
                    value={address.line1}
                    onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                  />
                  <input
                    type="text"
                    className={styles.textInput}
                    placeholder="Suite, floor (optional)"
                    value={address.line2}
                    onChange={(e) => setAddress({ ...address, line2: e.target.value })}
                  />
                  <div className={styles.quoteAddressRow}>
                    <input
                      type="text"
                      className={styles.textInput}
                      placeholder="City"
                      value={address.city}
                      onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    />
                    <input
                      type="text"
                      className={`${styles.textInput} ${styles.mono}`}
                      placeholder="ST"
                      maxLength={2}
                      value={address.state}
                      onChange={(e) => setAddress({ ...address, state: e.target.value.toUpperCase() })}
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      className={`${styles.textInput} ${styles.mono}`}
                      placeholder="ZIP"
                      value={address.postal_code}
                      onChange={(e) => setAddress({ ...address, postal_code: e.target.value })}
                    />
                  </div>
                  <p className={styles.fieldHint}>
                    Needed so Stripe can place the sale for tax — the total never changes.
                  </p>
                </div>
                <p className={styles.fieldHint}>
                  The quote bills to the supplier’s email on file — change it on the
                  supplier record if the billing contact differs.
                </p>
                {error && <p className={styles.fieldError}>{error}</p>}
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    disabled={busy}
                    onClick={() => setShowModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={busy || target == null || !addressComplete}
                    onClick={submit}
                  >
                    {busy ? 'Building…' : 'Create quote'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
