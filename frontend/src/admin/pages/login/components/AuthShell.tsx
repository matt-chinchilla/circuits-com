// AuthShell — the two-panel auth chrome shared by the login + reset-password
// pages (ported from the v13 design's AuthApp shell). Left: dark steel brand
// panel with the IsoBoard; right: the form column, with `children` slotted into
// the .card. Only this component imports the SCSS module; everything it hosts
// uses the design's literal class strings (scoped via .authRoot).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import IsoBoard from './IsoBoard';
import { I, Svg } from './icons';
import styles from '../LoginPage.module.scss';

export default function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.authRoot}>
      <div className="auth">
        {/* ── brand / atmosphere ── */}
        <aside className="brand">
          <div className="brand-top">
            <span className="logo">
              <span className="logo-node" />
              <span className="logo-word">Circuits.com</span>
            </span>
            <span className="brand-tag">Account</span>
          </div>
          <IsoBoard />
          <div className="brand-mid">
            <p className="brand-kicker">Member Access</p>
            <h1>
              Your account,
              <br />
              your <em>components</em>.
            </h1>
            <p className="brand-sub">
              Search millions of components, track the parts you need and manage your
              Circuits.com account &mdash; all from one secure place.
            </p>
          </div>
          <div className="brand-foot">
            <span className="stat">
              <span className="led" />
              Secure terminal
            </span>
            <span className="sep" />
            <span className="stat hide-sm">TLS 1.3 &middot; AES-256</span>
            <span className="sep hide-sm" />
            <span className="stat hide-sm">U1 &middot; circuits.com</span>
          </div>
        </aside>

        {/* ── form ── */}
        <main className="form-side">
          <div className="form-side-top">
            <Link className="back-site" to="/">
              <Svg d={I.out} w={14} />
              Back to site
            </Link>
          </div>
          <div className="form-wrap">
            <div className="card">{children}</div>
          </div>
          <p className="legal">
            Protected access &middot; <Link to="/privacy">Privacy</Link> &middot;{' '}
            <Link to="/terms">Terms</Link>
            <br />
            &copy; 2026 Circuits.com &mdash; All rights reserved.
          </p>
        </main>
      </div>
    </div>
  );
}
