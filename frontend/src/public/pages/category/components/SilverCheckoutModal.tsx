import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { api } from '@public/services/api';
// Owns the `.sck-*` rules; imported here (not only via SilverPartners) so the
// receipt state paints on a page that never renders the board itself.
import './silverPartners.scss';

// The self-serve Silver panel — a "placement ticket": a dark PCB header band
// (dot grid, crop marks, gold edge fingers) over a light body. Two states:
//
//   confirm — opens over the dimmed board so the buyer never loses sight of
//             the slot. Company + work email, the all-in price, then a
//             handoff to Stripe's HOSTED checkout. No payment surface ever
//             renders in this SPA — the design kit's Stripe page is a MOCK
//             and is deliberately not ported.
//   receipt — rendered on the way back (?welcome=silver, the session's
//             success_url), by CategoryPage which owns that param.
//
// Honesty rules for the receipt: the sponsor row is created by the WEBHOOK,
// which may not have landed when this paints, so nothing here claims the
// placement is LIVE — the status is "payment received", and the board itself
// is the proof once refreshed. The kit's fabricated SUB-ID and NEXT INVOICE
// rows are dropped for the same reason: neither value is known here.
//
// Styling lives in silverPartners.scss (`.sck-*`, global namespace like the
// rest of the board).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the confirm panel leaves behind before handing off to Stripe, so the
// receipt can greet the buyer by name. sessionStorage, one key: it belongs to
// this tab's purchase and must not outlive it. The return trip may legitimately
// land in a different tab or browser, so every read tolerates absence — an
// un-personalized receipt is correct, a wrong name is not.
const STASH_KEY = 'cc.silverCheckout';

interface CheckoutStash {
  company?: string;
  email?: string;
  board?: string;
  monthly?: number;
  ts?: number;
}

// Stripe Checkout Sessions expire after 24h — a stash older than that cannot
// belong to a purchase that just completed, so treat it as absent rather than
// greet this buyer with a previous attempt's name.
const STASH_TTL_MS = 24 * 60 * 60 * 1000;

function takeStash(): CheckoutStash | null {
  try {
    const raw = window.sessionStorage.getItem(STASH_KEY);
    window.sessionStorage.removeItem(STASH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const stash = parsed as CheckoutStash;
    if (typeof stash.ts !== 'number' || Date.now() - stash.ts > STASH_TTL_MS) return null;
    return stash;
  } catch {
    // Storage disabled / quota / malformed JSON — the receipt degrades to the
    // un-personalized copy, which is exactly what absence means here.
    return null;
  }
}

function writeStash(value: CheckoutStash): void {
  try {
    window.sessionStorage.setItem(STASH_KEY, JSON.stringify(value));
  } catch {
    /* Safari private mode and friends — the greeting is a nicety, never a gate. */
  }
}

interface ConfirmProps {
  variant?: 'confirm';
  /** The subcategory being sold — what a self-serve purchase is FOR. */
  categoryId: string;
  categoryName: string;
  /** All-in monthly price, from the server probe. Never hardcoded here. */
  monthlyTotal: number;
  onClose: () => void;
}

interface ReceiptProps {
  variant: 'receipt';
  categoryName: string;
  onClose: () => void;
}

export type SilverCheckoutModalProps = ConfirmProps | ReceiptProps;

export default function SilverCheckoutModal(props: SilverCheckoutModalProps): ReactElement {
  const { categoryName, onClose } = props;
  const receipt = props.variant === 'receipt';
  const navigate = useNavigate();

  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read ONCE at mount and cleared in the same breath, so re-opening a shared
  // ?welcome=silver URL can never replay someone else's name. Opening a FRESH
  // confirm panel also discards any leftover stash — an abandoned earlier
  // attempt (Stripe's cancel path sets no marker) must not personalize a
  // later receipt.
  const [stash] = useState<CheckoutStash | null>(() => {
    if (props.variant === 'receipt') return takeStash();
    try {
      window.sessionStorage.removeItem(STASH_KEY);
    } catch {
      /* storage disabled — nothing stale to clear either */
    }
    return null;
  });
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where the pointer went DOWN. A text-selection drag that starts inside an
  // input and releases over the scrim fires `click` on the scrim with
  // target===currentTarget — close only when the press started there too.
  const scrimPress = useRef(false);

  // Body-scroll lock for both states. Esc closes the confirm panel only: the
  // receipt is the buyer's proof of payment and is dismissed deliberately.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !receipt) onClose();
    };
    window.addEventListener('keydown', onKey);
    // aria-modal without a focus move leaves the keyboard user behind the
    // scrim; the panel itself takes focus (tabIndex -1) so Tab lands on the
    // first field / the Done button next.
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [receipt, onClose]);

  const companyOk = company.trim().length >= 2;
  const emailOk = EMAIL_RE.test(email.trim());

  const submit = async () => {
    if (props.variant === 'receipt') return;
    if (!companyOk || !emailOk) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.createSilverCheckout({
        category_id: props.categoryId,
        company_name: company.trim(),
        email: email.trim(),
        website: website.trim() || undefined,
      });
      // Written only once Stripe has handed back a URL — a failed mint must
      // not leave a stash that greets a buyer who never paid.
      writeStash({
        company: company.trim(),
        email: email.trim(),
        board: categoryName,
        monthly: props.monthlyTotal,
        ts: Date.now(),
      });
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 422) {
        // The only field the server validates beyond the client's gates is the
        // email (EmailStr) — name it, or the buyer retries the same value
        // against a message that sounds like an outage.
        setError('That email address doesn’t look valid to our billing system — check it and try again.');
      } else if (status === 409) {
        // The last slot filled while this panel was open.
        setError('This board just filled up — contact the partners desk below and they can waitlist you.');
      } else {
        setError('Could not start checkout — try again, or contact the partners desk below.');
      }
    }
  };

  const toContact = () => {
    onClose();
    navigate('/contact');
  };

  const receiptMonthly = typeof stash?.monthly === 'number' ? stash.monthly : null;
  // Server-probed price, carried by the confirm props only. Pulled out here
  // because JSX inside the receipt/confirm ternary can't narrow `props`.
  const monthlyTotal = props.variant === 'receipt' ? null : props.monthlyTotal;

  // Portaled to <body>: the board sits inside stacking/transform contexts
  // (the tier row, the flashlight boards) that would otherwise paint page
  // chrome through a non-portaled backdrop.
  return createPortal(
    <div
      className="sck-scrim"
      onMouseDown={(e) => {
        scrimPress.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (scrimPress.current && e.target === e.currentTarget && !receipt) onClose();
        scrimPress.current = false;
      }}
    >
      {receipt ? (
        <div
          className="sck-panel sck-done"
          role="dialog"
          aria-modal="true"
          aria-label="Sponsorship payment received"
          ref={panelRef}
          tabIndex={-1}
        >
          <header className="sck-head">
            <div className="sck-head-top">
              <span className="sck-kicker">SILVER SPONSORSHIP {'—'} CONFIRMED</span>
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
              Your Silver placement on <strong>{categoryName}</strong> is activating {'—'} the
              slot appears on this board within a minute.{' '}
              <button
                type="button"
                className="sck-refresh"
                onClick={() => window.location.reload()}
              >
                Refresh
              </button>{' '}
              to see it.
            </p>
            {stash?.email ? (
              <p className="sck-done-line">
                A confirmation is on its way to <code>{stash.email}</code>.
              </p>
            ) : null}
            <div className="sck-receipt">
              <div>
                <span>BOARD</span>
                <span>{(categoryName || stash?.board || '').toUpperCase()}</span>
              </div>
              <div>
                <span>TIER</span>
                <span>SILVER{receiptMonthly != null ? ` · $${receiptMonthly}/MO` : ''}</span>
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
              <button type="button" className="sck-btn sck-btn-ghost" onClick={toContact}>
                Questions? Contact the desk
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="sck-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Sponsor this slot"
          ref={panelRef}
          tabIndex={-1}
        >
          <header className="sck-head">
            <div className="sck-head-top">
              <span className="sck-kicker">SILVER SPONSORSHIP {'—'} SELF-SERVE</span>
              <span className="sck-slotchip">
                <i aria-hidden="true"></i>OPEN SLOT
              </span>
            </div>
            <h3 className="sck-title">{categoryName}</h3>
            <div className="sck-pricerow">
              <span className="sck-price">
                {monthlyTotal != null ? `$${monthlyTotal}` : null}
              </span>
              <span className="sck-per">
                per month {'·'} tax included
                <br />
                12-month minimum term, billed monthly
              </span>
            </div>
            <span className="sck-fingers" aria-hidden="true"></span>
          </header>
          <div className="sck-body">
            <ul className="sck-perks">
              <li>Logo and link on this subcategory board</li>
              <li>Publish part listings across this directory</li>
              <li>Partner platform access to manage your listings</li>
            </ul>
            <div className="sck-fields">
              <label className="sck-f" htmlFor="sck-company">
                <span>
                  Company name
                  <i className="req" aria-hidden="true">
                    *
                  </i>
                </span>
                {/* type="text" + inputMode, never type="email": an HTML5-invalid
                    value silently kills submit with no styling and no error
                    (the repo-wide input rule). Validation is the JS regex. */}
                <input
                  id="sck-company"
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Acme Electronics, Inc."
                  autoComplete="organization"
                  aria-required="true"
                  maxLength={120}
                />
              </label>
              <label className="sck-f" htmlFor="sck-email">
                <span>
                  Work email
                  <i className="req" aria-hidden="true">
                    *
                  </i>
                </span>
                <input
                  id="sck-email"
                  type="text"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="sales@company.com"
                  autoComplete="email"
                  aria-required="true"
                  maxLength={200}
                />
              </label>
              {/* Not in the kit's two-field panel, but load-bearing product-wise:
                  the webhook copies this onto the supplier row, and without it a
                  paid slot renders with no buy-link — the very thing the perks
                  list above promises. Optional; the board hides the link when
                  absent. */}
              <label className="sck-f sck-f-wide" htmlFor="sck-website">
                <span>
                  Website <em className="sck-opt">optional — your buy-link on the board</em>
                </span>
                <input
                  id="sck-website"
                  type="text"
                  inputMode="url"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
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
                Prefer a human? The partners desk answers same-day {'—'} same price either way.
              </span>
              <button type="button" className="sck-link" onClick={toContact}>
                Contact us
              </button>
            </div>
            <div className="sck-actions">
              <button
                type="button"
                className="sck-btn sck-btn-ghost sck-cancel"
                onClick={onClose}
              >
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
      )}
    </div>,
    document.body,
  );
}
