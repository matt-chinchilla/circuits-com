import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { api } from '@public/services/api';
import {
  checkoutErrorMessage,
  clearStash,
  money,
  parseStash,
  takeStash,
  writeStash,
  EXCLUSIVE_STASH_KEY,
  type ExclusiveStash,
  type ExclusiveTier,
  type SlotRow,
} from './exclusive';
// The `.sck-*` placement ticket (global) — the same panel Silver buyers see,
// retinted per tier by `.panel[data-tier]` in ExclusiveCheckout.module.scss.
import '../category/components/silverPartners.scss';
import x from './ExclusiveCheckout.module.scss';

// Gold/Platinum checkout handoff (spec 2026-09-23 §11). Mirrors
// SilverCheckoutModal's rules exactly:
//
//   confirm — company + work email (+ optional website), the server's price,
//             then POST /api/checkout/exclusive, which COMMITS a hold on the
//             slot and returns Stripe's hosted URL. No payment surface ever
//             renders in this SPA.
//   receipt — /join?welcome=gold|platinum (the session's success_url). The
//             sponsor row is created by the WEBHOOK, which may not have landed
//             yet, so the receipt says PAYMENT RECEIVED and never "live".
//
// The stash (sessionStorage `cc.exclusiveCheckout`) is written only after the
// URL comes back, read once, 24 h TTL. It also carries the hold's
// release_token, so the buyer's own Back path frees the slot at once.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ConfirmProps {
  variant?: 'confirm';
  tier: ExclusiveTier;
  tierName: string;
  slot: SlotRow;
  /** The charged monthly price the server returned. Never computed here. */
  priceUsd: number;
  listUsd: number | null;
  /** Only a code the server accepted; the server re-validates it anyway. */
  code?: string;
  perks: string[];
  onClose: () => void;
  onAskDesk: () => void;
  /** The slot was taken/held under us — the page re-reads the list. */
  onSlotLost: () => void;
}

interface ReceiptProps {
  variant: 'receipt';
  tier: ExclusiveTier;
  tierName: string;
  onClose: () => void;
}

export type ExclusiveCheckoutModalProps = ConfirmProps | ReceiptProps;

function peekStash(): ExclusiveStash | null {
  try {
    return parseStash(window.sessionStorage.getItem(EXCLUSIVE_STASH_KEY), Date.now());
  } catch {
    return null;
  }
}

export default function ExclusiveCheckoutModal(props: ExclusiveCheckoutModalProps): ReactElement {
  const { tier, tierName, onClose } = props;
  const receipt = props.variant === 'receipt';

  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Receipt: read ONCE and cleared in the same breath, so a shared
  // ?welcome= URL can never replay someone else's name.
  const [stash] = useState<ExclusiveStash | null>(() =>
    props.variant === 'receipt' ? takeStash() : null,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrimPress = useRef(false);
  // Set when the slot was taken/held under us: closing then asks the page to
  // re-read the list instead of leaving a stale "open" row behind.
  const lostRef = useRef(false);

  // Body-scroll lock for both states; Esc closes the confirm panel only (the
  // receipt is the buyer's proof of payment and is dismissed deliberately).
  // `close` changes every render; Esc reads the latest through a ref so the
  // listener (and the focus move) are installed once.
  const closeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !receipt) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [receipt]);

  const companyOk = company.trim().length >= 2;
  const emailOk = EMAIL_RE.test(email.trim());

  const submit = async () => {
    if (props.variant === 'receipt') return;
    if (!companyOk || !emailOk || busy) return;
    setBusy(true);
    setError(null);
    // An earlier attempt from THIS tab that never came back through the
    // cancel URL (browser Back from Stripe) still holds a slot — ours. Starting
    // a new checkout abandons it, so free it first, or our own hold 409s us.
    const previous = peekStash();
    if (previous?.release_token) {
      await api.releaseExclusiveHold(previous.release_token).catch(() => undefined);
    }
    clearStash();
    try {
      const res = await api.createExclusiveCheckout({
        tier,
        category_id: props.slot.category_id,
        code: props.code,
        company_name: company.trim(),
        email: email.trim(),
        website: website.trim() || undefined,
      });
      // Written only once Stripe handed back a URL — a failed mint must not
      // leave a stash that greets a buyer who never paid.
      writeStash({
        tier,
        release_token: res.release_token,
        slot_id: props.slot.category_id,
        slot_name: props.slot.name,
        slot_path: props.slot.path,
        company: company.trim(),
        email: email.trim(),
        price_usd: props.priceUsd,
        ts: Date.now(),
      });
      window.location.assign(res.url);
    } catch (err) {
      setBusy(false);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const detail: unknown = axios.isAxiosError(err)
        ? (err.response?.data as { detail?: unknown } | undefined)?.detail
        : undefined;
      const heldUntil = axios.isAxiosError(err)
        ? ((err.response?.headers?.['x-held-until'] as string | undefined) ?? null)
        : null;
      setError(checkoutErrorMessage(status, detail, heldUntil));
      if (status === 409 && (detail === 'slot_taken' || detail === 'slot_held')) {
        // Keep the message readable; the list behind refreshes on close.
        lostRef.current = true;
      }
    }
  };
  const close = () => {
    if (busy) return;
    if (props.variant !== 'receipt' && lostRef.current) props.onSlotLost();
    else onClose();
  };
  closeRef.current = close;

  const receiptPrice = typeof stash?.price_usd === 'number' ? stash.price_usd : null;
  const confirm = props.variant === 'receipt' ? null : props;
  const discounted =
    confirm != null && confirm.listUsd != null && confirm.priceUsd < confirm.listUsd;

  return createPortal(
    <div
      className="sck-scrim"
      onMouseDown={e => {
        scrimPress.current = e.target === e.currentTarget;
      }}
      onClick={e => {
        if (scrimPress.current && e.target === e.currentTarget && !receipt) close();
        scrimPress.current = false;
      }}
    >
      {receipt ? (
        <div
          className={`sck-panel sck-done ${x.panel}`}
          data-tier={tier}
          role="dialog"
          aria-modal="true"
          aria-label="Sponsorship payment received"
          ref={panelRef}
          tabIndex={-1}
        >
          <header className="sck-head">
            <div className="sck-head-top">
              <span className="sck-kicker">
                {tierName.toUpperCase()} SPONSORSHIP {'—'} CONFIRMED
              </span>
              <span className="sck-slotchip">
                <i aria-hidden="true"></i>PAYMENT RECEIVED
              </span>
            </div>
            <span className="sck-mark" aria-hidden="true">
              &#10003;
            </span>
            <h3 className="sck-title">
              Welcome aboard{stash?.company ? ', ' + stash.company : ''}.
            </h3>
            <span className="sck-fingers" aria-hidden="true"></span>
          </header>
          <div className="sck-body">
            <p className="sck-done-line">
              {stash?.slot_name ? (
                <>
                  Your {tierName} placement on <strong>{stash.slot_name}</strong> is activating{' '}
                  {'—'} it appears on the board within a minute.
                </>
              ) : (
                <>Your {tierName} placement is activating {'—'} it appears on its board within a minute.</>
              )}{' '}
              {stash?.slot_path ? (
                <Link className="sck-refresh" to={stash.slot_path} onClick={onClose}>
                  See the board
                </Link>
              ) : null}
            </p>
            {stash?.email ? (
              <p className="sck-done-line">
                A receipt is on its way to <code>{stash.email}</code>.
              </p>
            ) : null}
            <div className="sck-receipt">
              {stash?.slot_name ? (
                <div>
                  <span>SLOT</span>
                  <span>{stash.slot_name.toUpperCase()}</span>
                </div>
              ) : null}
              <div>
                <span>TIER</span>
                <span>
                  {tierName.toUpperCase()}
                  {receiptPrice != null ? ` · ${money(receiptPrice)}/MO` : ''}
                </span>
              </div>
              <div>
                <span>TERM</span>
                <span>12-MO MIN {'·'} MONTHLY</span>
              </div>
              <div>
                <span>STATUS</span>
                <span className="ok">PAYMENT RECEIVED</span>
              </div>
            </div>
            <div className="sck-actions">
              <button type="button" className="sck-btn sck-btn-primary" onClick={onClose}>
                Done
              </button>
              <Link className="sck-btn sck-btn-ghost" to="/contact" onClick={onClose}>
                Questions? Contact the desk
              </Link>
            </div>
          </div>
        </div>
      ) : confirm ? (
        <div
          className={`sck-panel ${x.panel}`}
          data-tier={tier}
          role="dialog"
          aria-modal="true"
          aria-label={`Buy the ${tierName} slot on ${confirm.slot.name}`}
          ref={panelRef}
          tabIndex={-1}
        >
          <header className="sck-head">
            <div className="sck-head-top">
              <span className="sck-kicker">
                {tierName.toUpperCase()} SPONSORSHIP {'—'} SELF-SERVE
              </span>
              <span className="sck-slotchip">
                <i aria-hidden="true"></i>OPEN SLOT
              </span>
            </div>
            <h3 className="sck-title">
              {confirm.slot.name}
              <span className={x.panelSub}>
                {confirm.slot.parent_name
                  ? `Sole sponsor of this ${confirm.slot.parent_name} subcategory`
                  : 'Sole sponsor of this top-level category'}
              </span>
            </h3>
            <div className="sck-pricerow">
              <span className="sck-price">{money(confirm.priceUsd)}</span>
              <span className="sck-per">
                per month {'·'} tax included
                <br />
                12-month minimum term, billed monthly
                {discounted && confirm.listUsd != null ? (
                  <span className={x.dealLine}>
                    {confirm.code ? 'Founder’s Deal + your rep’s code' : 'Founder’s Deal'}
                    {' · list '}
                    <s>{money(confirm.listUsd)}</s>
                  </span>
                ) : null}
              </span>
            </div>
            <span className="sck-fingers" aria-hidden="true"></span>
          </header>
          <div className="sck-body">
            <ul className="sck-perks">
              {confirm.perks.map(p => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="sck-fields">
              <label className="sck-f" htmlFor="xck-company">
                <span>
                  Company name
                  <i className="req" aria-hidden="true">
                    *
                  </i>
                </span>
                {/* type="text" + inputMode with JS validation — the repo-wide
                    input rule (an HTML5-typed input silently blocks submit). */}
                <input
                  id="xck-company"
                  type="text"
                  value={company}
                  onChange={e => setCompany(e.target.value)}
                  placeholder="Acme Electronics, Inc."
                  autoComplete="organization"
                  aria-required="true"
                  maxLength={120}
                />
              </label>
              <label className="sck-f" htmlFor="xck-email">
                <span>
                  Work email
                  <i className="req" aria-hidden="true">
                    *
                  </i>
                </span>
                <input
                  id="xck-email"
                  type="text"
                  inputMode="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="sales@company.com"
                  autoComplete="email"
                  aria-required="true"
                  maxLength={200}
                />
              </label>
              <label className="sck-f sck-f-wide" htmlFor="xck-website">
                <span>
                  Website <em className="sck-opt">optional — your buy-link on the board</em>
                </span>
                <input
                  id="xck-website"
                  type="text"
                  inputMode="url"
                  value={website}
                  onChange={e => setWebsite(e.target.value)}
                  placeholder="yourcompany.com"
                  autoComplete="url"
                  maxLength={200}
                />
              </label>
            </div>
            {error ? (
              <p className="sck-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="sck-rep">
              <span className="sck-rep-id">
                Continuing holds this slot for you while you pay {'—'} nobody else can buy it
                meanwhile.
              </span>
              <button type="button" className="sck-link" onClick={confirm.onAskDesk}>
                Ask the desk
              </button>
            </div>
            <div className="sck-actions">
              <button type="button" className="sck-btn sck-btn-ghost sck-cancel" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="sck-btn sck-btn-primary"
                disabled={busy || !companyOk || !emailOk}
                onClick={submit}
              >
                {busy ? 'Opening secure checkout…' : <>Continue to secure checkout{' →'}</>}
              </button>
            </div>
            <p className="sck-foot">STRIPE-SECURED {'—'} CARD DETAILS NEVER TOUCH CIRCUIT CENTER</p>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
