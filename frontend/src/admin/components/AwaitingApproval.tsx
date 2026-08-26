// D17's client half — what a verified but UNACTIVATED customer sees instead of
// the console.
//
// D16 puts every console page at /account unscoped and makes activation the
// compensating control, which the server enforces in one place
// (`require_account_user` → 403 `account_not_activated`). Until this screen
// existed the client had no matching half: the sign-in succeeded, the full
// console rendered, and then every panel on it fired a request that 403'd —
// a dozen failures presenting as a dozen bugs, on someone who had done
// everything right.
//
// So it is deliberately NOT an error state. There is nothing to retry, so
// nothing is presented as having failed: one sentence about where the account
// is, and the only two controls that mean anything here (leave, or sign out).
//
// Rendered inside AuthShell rather than the admin chrome because the console is
// exactly what this person may not have yet — a sidebar full of links that all
// 403 is worse than no sidebar. LAZY-loaded by ProtectedRoute (which App.tsx
// imports statically): AuthShell drags in the login SCSS module and the CSS-3D
// board, and none of that may reach the public entry chunk.
import { useAuth } from '@admin/contexts/AuthContext';
import AuthShell from '@admin/pages/login/components/AuthShell';

export default function AwaitingApproval() {
  const { user, logout } = useAuth();
  // Present on GET /auth/me, absent on the nested user of a login response —
  // so this is a reloaded tab's detail, not a guarantee. Rendered only when
  // known rather than printed as an empty string.
  const email = user?.email;

  return (
    <AuthShell>
      <div className="success">
        <p className="eyebrow">
          <span className="dot" />
          Account pending
        </p>
        <h2>Awaiting approval</h2>
        <p className="lede">
          Your email address is confirmed. A member of our team reviews every new account
          before it opens &mdash; we&rsquo;ll write to you as soon as yours is ready. There
          is nothing you need to do.
        </p>
        <div className="success-actions">
          <button type="button" className="btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
        {email && <p className="demo-note">Signed in as {email}</p>}
      </div>
    </AuthShell>
  );
}
