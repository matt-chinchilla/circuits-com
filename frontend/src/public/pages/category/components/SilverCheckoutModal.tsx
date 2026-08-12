import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@public/services/api';

// The self-serve confirm panel — opens over the dimmed Silver board so the
// buyer never loses sight of the slot. Two fields (company, optional site),
// the all-in price, and the partners-desk rep card (Q-series: transistors
// amplify, and so do reps). Submitting redirects to Stripe's HOSTED checkout
// — no payment surface ever renders in this SPA.
//
// Styling lives in silverPartners.scss (`.svco-*`, global namespace like the
// rest of the board).

interface Props {
  categoryId: string;
  categoryName: string;
  monthlyTotal: number;
  onClose: () => void;
}

const REP = {
  designator: 'Q2',
  name: 'Daniel',
  email: 'daniel@circuitcenter.ai',
  line: 'Sets up most Silver placements same-day',
};

export default function SilverCheckoutModal({
  categoryId,
  categoryName,
  monthlyTotal,
  onClose,
}: Props): ReactElement {
  const [company, setCompany] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (company.trim().length < 2) {
      setError('Company name is what appears on the board — two characters or more.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.createSilverCheckout({
        category_id: categoryId,
        company_name: company.trim(),
        website: website.trim() || undefined,
      });
      window.location.assign(url);
    } catch {
      setBusy(false);
      setError('Could not start checkout — try again, or email the partners desk below.');
    }
  };

  // Portaled to <body>: the board sits inside stacking/transform contexts
  // (the tier row, the flashlight boards) that would otherwise paint page
  // chrome through a non-portaled backdrop.
  return createPortal(
    <div className="svco-backdrop" role="dialog" aria-modal="true" aria-label="Sponsor this slot">
      <div className="svco-card">
        <div className="svco-head">
          <div>
            <span className="svco-des">SILVER {'·'} {categoryName.toUpperCase()}</span>
            <h3>Silver placement</h3>
          </div>
          <div className="svco-price">
            ${monthlyTotal}
            <small>/mo {'·'} tax included</small>
          </div>
        </div>
        <ul className="svco-benefits">
          <li>Your logo and link on this board, on every visit</li>
          <li>Listed across the {categoryName} directory</li>
          <li>Partner platform access {'—'} manage your listings</li>
        </ul>
        <label className="svco-label" htmlFor="svco-company">
          Company name <span aria-hidden="true">*</span>
        </label>
        <input
          id="svco-company"
          type="text"
          className="svco-input"
          placeholder="As it should appear on the board"
          value={company}
          onChange={e => setCompany(e.target.value)}
          maxLength={120}
        />
        <label className="svco-label" htmlFor="svco-website">
          Website <span className="svco-opt">optional</span>
        </label>
        <input
          id="svco-website"
          type="text"
          inputMode="url"
          className="svco-input"
          placeholder="yourcompany.com"
          value={website}
          onChange={e => setWebsite(e.target.value)}
          maxLength={200}
        />
        {error && <p className="svco-error">{error}</p>}
        <button type="button" className="svco-cta" disabled={busy} onClick={submit}>
          {busy ? 'Opening secure checkout…' : 'Continue to secure checkout →'}
        </button>
        <p className="svco-sub">
          Monthly, cancel anytime {'·'} payment handled by <b>Stripe</b>
        </p>
        <div className="svco-rep">
          <span className="svco-ava" aria-hidden="true">
            {REP.name.charAt(0)}
          </span>
          <span className="svco-rep-id">
            <span className="svco-qdes">{REP.designator} {'·'} PARTNERS DESK</span>
            <b>{REP.name}</b> <small>{REP.line}</small>
          </span>
          <a className="svco-rep-mail" href={`mailto:${REP.email}`}>
            Email
          </a>
        </div>
        <p className="svco-note">
          <b>Same price either way</b> {'—'} a rep costs nothing extra, and Gold &amp;
          Platinum exclusives go through him.
        </p>
        <button type="button" className="svco-close" onClick={onClose} aria-label="Close">
          {'×'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
