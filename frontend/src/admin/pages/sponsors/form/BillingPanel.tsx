import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import ListSelect from '@admin/components/ListSelect/ListSelect';
import PriceRow from '@admin/components/ListSelect/PriceRow';
import { priceRowText, priceRows } from '@admin/components/ListSelect/priceRows';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorCode, isNoBillingAccess } from '@admin/services/apiError';
import { useAuth } from '@admin/contexts/AuthContext';
import { copyText } from '@admin/services/clipboard';
import ConfirmAction from '@admin/components/ConfirmAction';
import { safeHttpUrl } from '@shared/utils/url';
import type {
  BillingInvoice,
  CardLinkResult,
  QuoteLadderTier,
  SponsorBillingView,
} from '@admin/types/admin';
import {
  billingStatusLabel,
  billingTone,
  cardLinkMailto,
  cents,
  formatDay,
  invoiceStatusLabel,
  parseDollarsToCents,
  refundableCents,
} from './billingFormat';
import formStyles from './SponsorFormPage.module.scss';
import styles from './BillingPanel.module.scss';

// The rep's billing console for ONE sponsorship (spec §9, D3): what Stripe is
// charging, when, on which card, every invoice — and the actions a rep would
// otherwise need the Stripe dashboard for: cancel (and undo), refund, change
// the discount, retry a failed payment, send a card-update link.
//
// Rendered after QuotePanel, OUTSIDE the sponsor <form> (its buttons must
// never submit the sponsorship). Hidden on 404 — Stripe unconfigured, or no
// billing for this row — like QuotePanel. A view-only account is refused the
// read (R6, 403 no_billing_access) and sees one quiet line instead.
//
// Every number is the server's. Money actions go through ConfirmAction, which
// states the consequence and carries the Idempotency-Key.

interface Props {
  sponsorId: string;
  /** The PERSISTED tier — prices come from the server ladder for it. */
  tier: string;
  /** Who the dialogs name ("Refund $2,100.00 to Acme?"). */
  companyName: string;
  /** Cancel-now expired the sponsor row server-side; the form should follow. */
  onSponsorExpired?: () => void;
}

type Phase = 'loading' | 'hidden' | 'blocked' | 'error' | 'ready';

type Dialog =
  | { kind: 'period_end' }
  | { kind: 'resume' }
  | { kind: 'now' }
  | { kind: 'discount' }
  | { kind: 'retry'; invoice: BillingInvoice }
  | { kind: 'card' }
  | { kind: 'refund'; invoice: BillingInvoice };

const CHANNEL_LABEL: Record<string, string> = {
  self_serve: 'Bought on /join',
  rep_code: 'Rep code',
  quote: 'Quote',
};

function usd(whole: number | null | undefined): string {
  return whole == null ? '—' : `$${whole.toLocaleString('en-US')}`;
}

function invoiceTime(inv: BillingInvoice): number {
  const v = inv.created;
  if (typeof v === 'number') return v * 1000;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function stripeLink(url: string | null): string | null {
  return safeHttpUrl(url);
}

export default function BillingPanel({ sponsorId, tier, companyName, onSponsorExpired }: Props) {
  const { isReadOnly } = useAuth();
  const [phase, setPhase] = useState<Phase>('loading');
  const [billing, setBilling] = useState<SponsorBillingView | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cardLink, setCardLink] = useState<CardLinkResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [ladder, setLadder] = useState<QuoteLadderTier | null>(null);

  // Dialog inputs.
  const [refundMode, setRefundMode] = useState<'full' | 'partial'>('full');
  const [refundAmount, setRefundAmount] = useState('');
  const [points, setPoints] = useState(0);

  const company = companyName.trim() || 'this sponsor';

  const load = useCallback(() => {
    let cancelled = false;
    adminApi
      .getSponsorBilling(sponsorId)
      .then((data) => {
        if (cancelled) return;
        setBilling(data);
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        if (isNoBillingAccess(err)) setPhase('blocked');
        else if (apiErrorCode(err).status === 404) setPhase('hidden');
        else setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sponsorId]);

  useEffect(load, [load]);

  // The discount dialog lists the server's own price for every step.
  useEffect(() => {
    if (dialog?.kind !== 'discount' || ladder) return;
    let cancelled = false;
    adminApi
      .getQuoteLadder()
      .then((data) => {
        if (!cancelled) setLadder(data.tiers[tier.trim().toLowerCase()] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dialog, ladder, tier]);

  const invoices = useMemo(
    () => [...(billing?.invoices ?? [])].sort((a, b) => invoiceTime(b) - invoiceTime(a)),
    [billing],
  );
  const oldestOpen = useMemo(
    () =>
      [...invoices].reverse().find((inv) => inv.status === 'open') ?? null,
    [invoices],
  );

  if (phase === 'hidden' || phase === 'loading') return null;

  if (phase === 'blocked' || phase === 'error' || !billing) {
    return (
      <section className={`${formStyles.panel} ${formStyles.panelStacked}`}>
        <header className={formStyles.panelHead}>
          <h2 className={formStyles.panelTitle}>Billing</h2>
        </header>
        <div className={formStyles.panelBody}>
          {phase === 'blocked' ? (
            <p className={formStyles.fieldHint}>Billing is hidden from view-only accounts.</p>
          ) : (
            <p className={styles.inlineError}>
              Stripe could not be reached for this sponsorship.{' '}
              <button type="button" className={styles.linkButton} onClick={() => { setPhase('loading'); load(); }}>
                Try again
              </button>
            </p>
          )}
        </div>
      </section>
    );
  }

  const b = billing;
  const hasSub = Boolean(b.subscription_id) && !b.needs_resolution;
  const live = hasSub && b.status !== 'canceled' && b.status !== 'incomplete_expired';
  const byInvoice = b.collection_method === 'send_invoice';
  const canWrite = !isReadOnly && live;
  const discounted = b.price_usd != null && b.list_usd != null && b.price_usd < b.list_usd;
  const periodEndDay = formatDay(b.period_end);

  const finish = async (message: string) => {
    setDialog(null);
    setNotice(message);
    load();
  };

  const openDialog = (next: Dialog) => {
    setNotice(null);
    if (next.kind === 'refund') {
      setRefundMode('full');
      setRefundAmount('');
    }
    if (next.kind === 'discount') setPoints(b.code_points ?? 0);
    setDialog(next);
  };

  // ── Dialog bodies ─────────────────────────────────────────────────────────
  let confirm: ReactElement | null = null;
  if (dialog?.kind === 'period_end') {
    confirm = (
      <ConfirmAction
        title={`Cancel ${company}’s sponsorship on ${periodEndDay}?`}
        body={
          <p>
            They keep the board until then and are not charged again. You can undo this any
            time before {periodEndDay}.
          </p>
        }
        confirmLabel="Cancel at period end"
        busyLabel="Scheduling…"
        onConfirm={async (key) => {
          await adminApi.cancelBilling(sponsorId, 'period_end', key);
          await finish(`Scheduled — the sponsorship ends ${periodEndDay}.`);
        }}
        onClose={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === 'resume') {
    confirm = (
      <ConfirmAction
        title={`Keep ${company}’s sponsorship running?`}
        body={
          <p>
            The scheduled cancellation is removed and billing continues
            {b.next_charge ? ` — ${cents(b.next_charge.amount_cents)} on ${formatDay(b.next_charge.date)}` : ''}.
          </p>
        }
        confirmLabel="Keep it running"
        busyLabel="Resuming…"
        onConfirm={async (key) => {
          await adminApi.cancelBilling(sponsorId, 'resume', key);
          await finish('Resumed — billing continues as before.');
        }}
        onClose={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === 'now') {
    confirm = (
      <ConfirmAction
        tone="danger"
        title={`End ${company}’s sponsorship now?`}
        body={
          <>
            <p>
              The board comes down immediately, the slot reopens, and open invoices are voided.
            </p>
            <p>Nothing is refunded automatically &mdash; refund an invoice below if they are owed money.</p>
          </>
        }
        confirmLabel="End it now"
        busyLabel="Ending…"
        onConfirm={async (key) => {
          await adminApi.cancelBilling(sponsorId, 'now', key);
          onSponsorExpired?.();
          await finish('Ended — the sponsorship is now Expired and the slot is open.');
        }}
        onClose={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === 'retry') {
    const inv = dialog.invoice;
    confirm = (
      <ConfirmAction
        title={`Charge ${company} ${cents(inv.amount_due_cents - inv.amount_paid_cents)} now?`}
        body={
          <p>
            Stripe tries the card on file once for invoice {inv.number ?? inv.id}. If it fails
            again, the payment keeps failing and the sweep&rsquo;s cancel date does not move.
          </p>
        }
        confirmLabel="Charge the card"
        busyLabel="Charging…"
        onConfirm={async (key) => {
          await adminApi.retryPayment(sponsorId, key);
          await finish('Charged — Stripe accepted the payment.');
        }}
        onClose={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === 'card') {
    confirm = (
      <ConfirmAction
        title={`Create a card-update link for ${company}?`}
        body={
          <p>
            The link opens Stripe&rsquo;s secure page where they replace the card we charge. It
            works for 7 days, and a new link switches off any earlier one.
          </p>
        }
        confirmLabel="Create link"
        busyLabel="Creating…"
        onConfirm={async (key) => {
          const result = await adminApi.createCardLink(sponsorId, key);
          setCardLink(result);
          setCopied(false);
          await finish('Link ready — copy it or open it in an email below.');
        }}
        onClose={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === 'refund') {
    const inv = dialog.invoice;
    const max = refundableCents(inv);
    const partial = parseDollarsToCents(refundAmount);
    const amount = refundMode === 'full' ? max : partial;
    const valid = amount != null && amount > 0 && amount <= max;
    confirm = (
      <ConfirmAction
        tone="danger"
        title={valid ? `Refund ${cents(amount)} to ${company}?` : `Refund ${company}?`}
        body={
          <p>
            The money goes back to the card that paid invoice {inv.number ?? inv.id}. The
            sponsorship keeps running &mdash; cancel it separately if they are leaving.
          </p>
        }
        confirmLabel={valid ? `Refund ${cents(amount)}` : 'Refund'}
        busyLabel="Refunding…"
        canConfirm={valid}
        keyScope={`${inv.id}:${refundMode === 'full' ? 'full' : amount}`}
        onConfirm={async (key) => {
          await adminApi.refundInvoice(
            sponsorId,
            refundMode === 'full' ? { invoice_id: inv.id } : { invoice_id: inv.id, amount_cents: amount! },
            key,
          );
          await finish(`Refunded ${cents(amount)} — it reaches their card in 5 to 10 days.`);
        }}
        onClose={() => setDialog(null)}
      >
        <div className={styles.choice} role="radiogroup" aria-label="Refund amount">
          <label className={styles.choiceRow}>
            <input
              type="radio"
              name="refund-mode"
              checked={refundMode === 'full'}
              onChange={() => setRefundMode('full')}
            />
            Everything still paid &mdash; {cents(max)}
          </label>
          <label className={styles.choiceRow}>
            <input
              type="radio"
              name="refund-mode"
              checked={refundMode === 'partial'}
              onChange={() => setRefundMode('partial')}
            />
            Part of it
          </label>
          {refundMode === 'partial' && (
            <div className={styles.amountField}>
              <span aria-hidden="true">$</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label="Refund amount in dollars"
                className={formStyles.textInput}
                placeholder="0.00"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
              {partial != null && partial > max && (
                <span className={styles.fieldWarn}>More than the {cents(max)} left on this invoice</span>
              )}
            </div>
          )}
        </div>
      </ConfirmAction>
    );
  } else if (dialog?.kind === 'discount') {
    const options = ladder?.options ?? [];
    const chosen = options.find((o) => o.code_points === points) ?? null;
    confirm = (
      <ConfirmAction
        title={
          chosen
            ? `Charge ${company} ${usd(chosen.price_usd)}/mo from the next invoice?`
            : `Change ${company}’s price?`
        }
        body={
          <p>
            The new price applies from the next invoice on and stays until changed. It never
            goes below 70% of list{ladder ? ` (${usd(ladder.floor)})` : ''}.
          </p>
        }
        confirmLabel="Change the price"
        busyLabel="Updating Stripe…"
        canConfirm={chosen != null && chosen.code_points !== (b.code_points ?? 0)}
        keyScope={String(points)}
        onConfirm={async (key) => {
          await adminApi.changeDiscount(sponsorId, points, key);
          await finish(
            `Updated — ${chosen ? usd(chosen.price_usd) : 'the new price'}/mo from the next invoice.`,
          );
        }}
        onClose={() => setDialog(null)}
      >
        {ladder ? (
          <div className={formStyles.field}>
            <label className={formStyles.fieldLabel} htmlFor="billing-discount">
              Monthly price (tax included)
            </label>
            <ListSelect
              id="billing-discount"
              variant="price"
              value={points}
              options={priceRows(ladder, { current: b.code_points ?? 0 }).map((row) => ({
                value: row.value,
                label: priceRowText(row),
                content: <PriceRow row={row} />,
                keys: [String(row.value)],
              }))}
              onChange={setPoints}
            />
          </div>
        ) : (
          <p className={formStyles.fieldHint}>Loading prices&hellip;</p>
        )}
      </ConfirmAction>
    );
  }

  const tone = billingTone(b);
  const cardUrl = cardLink ? safeHttpUrl(cardLink.url) : null;

  return (
    <section className={`${formStyles.panel} ${formStyles.panelStacked}`} aria-labelledby="billing-panel-title">
      <header className={formStyles.panelHead}>
        <h2 id="billing-panel-title" className={formStyles.panelTitle}>
          Billing
        </h2>
        {b.channel && <span className={styles.channel}>{CHANNEL_LABEL[b.channel] ?? b.channel}</span>}
      </header>
      <div className={formStyles.panelBody}>
        {b.needs_resolution === 'ambiguous_subscription' && (
          <p className={styles.alert} data-tone="warn">
            Several Stripe subscriptions name this sponsorship, so nothing can be changed here
            until the owner picks the real one.
          </p>
        )}
        {b.needs_resolution === 'no_subscription' && (
          <p className={formStyles.fieldHint}>
            No Stripe subscription is attached yet. A quote becomes one when the customer accepts
            it and pays the first invoice.
          </p>
        )}

        {hasSub && (
          <>
            <div className={styles.statusStrip} data-tone={tone}>
              <span className={styles.statusDot} aria-hidden="true" />
              <span className={styles.statusText}>{billingStatusLabel(b)}</span>
              {byInvoice && <span className={styles.statusAside}>Pays by emailed invoice</span>}
            </div>

            <dl className={styles.ledger}>
              <div className={styles.ledgerCell}>
                <dt>List</dt>
                <dd className={discounted ? styles.struck : undefined}>{usd(b.list_usd)}</dd>
              </div>
              <div className={styles.ledgerCell}>
                <dt>Founder&rsquo;s Deal</dt>
                <dd>{usd(b.founder_usd)}</dd>
              </div>
              <div className={`${styles.ledgerCell} ${styles.ledgerCharge}`}>
                <dt>Charging</dt>
                <dd>
                  {usd(b.price_usd)}
                  <span className={styles.perMonth}>/mo</span>
                </dd>
              </div>
            </dl>
            <p className={styles.ledgerNote}>
              {[
                b.code_points ? `extra ${b.code_points}% off` : "Founder's Deal",
                b.code ? `code ${b.code}` : null,
                b.sold_by ? `sold by ${b.sold_by}` : null,
                'tax included',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            <dl className={styles.facts}>
              {b.next_charge && live && !b.cancel_scheduled && (
                <div>
                  <dt>Next charge</dt>
                  <dd>
                    {cents(b.next_charge.amount_cents)} on {formatDay(b.next_charge.date, { year: true })}
                  </dd>
                </div>
              )}
              {!byInvoice && (
                <div>
                  <dt>Card</dt>
                  <dd>
                    {b.card
                      ? `${b.card.brand.charAt(0).toUpperCase()}${b.card.brand.slice(1)} ending ${b.card.last4} · expires ${String(b.card.exp_month).padStart(2, '0')}/${String(b.card.exp_year).slice(-2)}`
                      : 'No card on file'}
                  </dd>
                </div>
              )}
              {byInvoice && oldestOpen && (
                <div>
                  <dt>Invoice due</dt>
                  <dd>
                    {formatDay(oldestOpen.due_date, { year: true })}
                    {stripeLink(oldestOpen.hosted_url) && (
                      <>
                        {' · '}
                        <a href={stripeLink(oldestOpen.hosted_url)!} target="_blank" rel="noopener noreferrer">
                          Invoice link
                        </a>
                      </>
                    )}
                  </dd>
                </div>
              )}
            </dl>

            {b.legacy_price && (
              <p className={formStyles.fieldHint}>
                This subscription is on an older price, so its discount cannot be changed here.
              </p>
            )}

            {canWrite && (
              <div className={styles.actions}>
                {b.cancel_scheduled ? (
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnPrimary}`}
                    onClick={() => openDialog({ kind: 'resume' })}
                  >
                    Keep it running
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    onClick={() => openDialog({ kind: 'discount' })}
                    disabled={b.legacy_price}
                  >
                    Change price
                  </button>
                )}
                {!byInvoice && (
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    onClick={() => openDialog({ kind: 'card' })}
                  >
                    Card-update link
                  </button>
                )}
                {!byInvoice && oldestOpen && (
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    onClick={() => openDialog({ kind: 'retry', invoice: oldestOpen })}
                  >
                    Retry payment
                  </button>
                )}
                <span className={styles.actionsSpacer} />
                {!b.cancel_scheduled && (
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    onClick={() => openDialog({ kind: 'period_end' })}
                  >
                    Cancel at period end
                  </button>
                )}
                <button
                  type="button"
                  className={`${formStyles.btn} ${formStyles.btnDanger}`}
                  onClick={() => openDialog({ kind: 'now' })}
                >
                  End now
                </button>
              </div>
            )}

            {cardLink && cardUrl && (
              <div className={styles.linkBox}>
                <code className={styles.linkText}>{cardUrl}</code>
                <div className={styles.linkActions}>
                  <button
                    type="button"
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    onClick={async () => setCopied(await copyText(cardUrl))}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <a
                    className={`${formStyles.btn} ${formStyles.btnGhost}`}
                    href={cardLinkMailto(cardLink.email, cardUrl, cardLink.expires_at)}
                  >
                    Open in email
                  </a>
                </div>
                <p className={formStyles.fieldHint}>
                  Works until {formatDay(cardLink.expires_at, { year: true })}
                  {cardLink.email ? ` · the email goes to ${cardLink.email}` : ' · no billing email on file'}.
                </p>
              </div>
            )}

            {notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
          </>
        )}

        {invoices.length > 0 && (
          <div className={styles.invoiceWrap}>
            <table className={styles.invoices}>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Date</th>
                  <th scope="col" className={styles.num}>Amount</th>
                  <th scope="col" className={styles.num}>Refunded</th>
                  <th scope="col">Status</th>
                  <th scope="col" aria-label="Documents and actions" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const status = invoiceStatusLabel(inv);
                  const refundable = refundableCents(inv);
                  const hosted = stripeLink(inv.hosted_url);
                  const pdf = stripeLink(inv.pdf_url);
                  return (
                    <tr key={inv.id}>
                      <td className={styles.mono}>{inv.number ?? inv.id}</td>
                      <td>{formatDay(inv.created, { year: true })}</td>
                      <td className={styles.num}>{cents(inv.amount_due_cents)}</td>
                      <td className={styles.num}>
                        {inv.amount_refunded_cents > 0 ? cents(inv.amount_refunded_cents) : '—'}
                      </td>
                      <td>
                        <span className={styles.invStatus} data-status={status.toLowerCase().replace(/\s+/g, '-')}>
                          {status}
                        </span>
                      </td>
                      <td className={styles.rowActions}>
                        {hosted && (
                          <a href={hosted} target="_blank" rel="noopener noreferrer">
                            View
                          </a>
                        )}
                        {pdf && (
                          <a href={pdf} target="_blank" rel="noopener noreferrer">
                            PDF
                          </a>
                        )}
                        {!isReadOnly && inv.status === 'paid' && refundable > 0 && (
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => openDialog({ kind: 'refund', invoice: inv })}
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirm}
    </section>
  );
}
