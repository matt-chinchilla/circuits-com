import { useCallback, useEffect, useState } from 'react';
import ListSelect from '@admin/components/ListSelect/ListSelect';
import PriceRow from '@admin/components/ListSelect/PriceRow';
import { priceRowText, priceRows } from '@admin/components/ListSelect/priceRows';
import {
  adminApi,
  type QuoteLadderResponse,
  type SponsorQuote,
} from '@admin/services/adminApi';
import { apiErrorDetail, isNoBillingAccess } from '@admin/services/apiError';
import { useAuth } from '@admin/contexts/AuthContext';
import styles from './SponsorFormPage.module.scss';

// Sales-led quotes on an EXISTING sponsorship: list the supplier's quotes,
// build a new one, download the PDF, mark it accepted once the customer says
// yes. Rendered OUTSIDE the <form> — its buttons must never submit the
// sponsorship.
//
// R12 (2026-09-23): a quote is priced by the SAME rule as /join — the rep
// picks the discount (0 = the Founder's Deal, then 1–15% more of list off,
// floored at 70% of list) and the server prices it. The select shows the
// server's own price for every step; nothing here computes one. Every price
// is a FINAL monthly total, tax included.
//
// Hidden entirely when billing is unconfigured (the routes 404). A view-only
// account sees the refusal as a quiet line, and never a write button.

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

function usd(whole: number): string {
  return `$${whole.toLocaleString('en-US')}`;
}

export default function QuotePanel({ sponsorId, tier }: Props) {
  const tierKey = tier.trim().toLowerCase();
  const { isReadOnly } = useAuth();

  const [ladder, setLadder] = useState<QuoteLadderResponse | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [quotes, setQuotes] = useState<SponsorQuote[]>([]);
  const [showModal, setShowModal] = useState(false);

  const [points, setPoints] = useState(0);
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
      .catch((err) => {
        if (!cancelled && isNoBillingAccess(err)) setBlocked(true);
      });
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
      .catch((err) => {
        if (cancelled) return;
        // A view-only account is refused (R6): say so quietly. Anything else
        // — 404 = STRIPE_SECRET_KEY unset, or a transient failure — hides the
        // panel: a panel the rep can re-enter beats a broken billing surface.
        if (isNoBillingAccess(err)) setBlocked(true);
        else setUnconfigured(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(refreshQuotes, [refreshQuotes]);

  if (unconfigured) return null;

  if (blocked) {
    return (
      <section className={`${styles.panel} ${styles.panelStacked}`}>
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Quotes</h2>
        </header>
        <div className={styles.panelBody}>
          <p className={styles.fieldHint}>Quotes are hidden from view-only accounts.</p>
        </div>
      </section>
    );
  }

  const rung = ladder?.tiers[tierKey];
  const options = rung?.options ?? [];
  const chosen = options.find((o) => o.code_points === points) ?? null;

  const openModal = () => {
    setPoints(0);
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
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.createSponsorQuote(sponsorId, {
        code_points: chosen.code_points,
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
    <section className={`${styles.panel} ${styles.panelStacked}`}>
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Quotes</h2>
      </header>
      <div className={styles.panelBody}>
        {rung && options.length > 0 ? (
          <>
            <p className={styles.fieldHint}>
              Quotes are priced like /join: the Founder&rsquo;s Deal is {usd(rung.founder)}/mo
              (list {usd(rung.list)}), and an extra discount of up to 15% of list comes off it &mdash; never
              below {usd(rung.floor)}. Tax is included, so the number the customer sees is
              exactly what they pay.
            </p>
            {!isReadOnly && (
              <div>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={openModal}>
                  New quote
                </button>
              </div>
            )}
          </>
        ) : ladder ? (
          <p className={styles.fieldHint}>
            No price rule exists for the &ldquo;{tier}&rdquo; tier &mdash; quotes cover Platinum,
            Gold and Silver placements.
          </p>
        ) : null}

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
                  {q.status === 'open' && !isReadOnly && (
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

      {showModal && rung && !isReadOnly && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="quote-modal-title">
          <div className={styles.modal}>
            {created ? (
              <>
                <h3 id="quote-modal-title" className={styles.modalTitle}>
                  Quote {created.number ?? created.quote_id} is ready
                </h3>
                <p className={styles.modalBody}>
                  Download the PDF and send it to the customer. When they say yes, use
                  &ldquo;Customer accepted&rdquo; on the quote below &mdash; Stripe then creates the
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
                <h3 id="quote-modal-title" className={styles.modalTitle}>
                  New quote &mdash; {tier}
                </h3>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="quote-price">
                    Monthly price (tax included)
                  </label>
                  {rung && (
                    <ListSelect
                      id="quote-price"
                      variant="price"
                      value={points}
                      options={priceRows(rung).map((row) => ({
                        value: row.value,
                        label: priceRowText(row),
                        content: <PriceRow row={row} />,
                        keys: [String(row.value)],
                      }))}
                      onChange={setPoints}
                    />
                  )}
                  <p className={styles.fieldHint}>
                    The customer pays exactly this amount, every month. Stripe accounts for NY
                    sales tax inside it.
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
                    Needed so Stripe can place the sale for tax &mdash; the total never changes.
                  </p>
                </div>
                <p className={styles.fieldHint}>
                  The quote bills to the supplier&rsquo;s email on file &mdash; change it on the
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
                    disabled={busy || !chosen || !addressComplete}
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
