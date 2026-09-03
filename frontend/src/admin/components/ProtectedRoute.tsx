import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import {
  isActivationLink,
  rememberActivation,
  takeActivationNotice,
} from '@admin/services/accountActivation';
import type { ReactNode } from 'react';

/**
 * Roles that belong on the CUSTOMER mount. Matches the `user_role` enum in
 * api/app/models/user.py, where a customer is `user` (renamed from `company`
 * by alembic 043); `admin`, `owner`, and the read-only `viewer` (051) are staff.
 */
const CUSTOMER_ROLES = ['user'];

// LAZY, deliberately: App.tsx imports ProtectedRoute STATICALLY (it has to gate
// before any chunk loads), so anything this file imports eagerly lands in the
// PUBLIC entry bundle. AwaitingApproval renders inside AuthShell — the login
// SCSS module and the CSS-3D board — and ActivationBanner carries its own SCSS.
// Each gets its OWN <Suspense> below rather than leaning on App.tsx's: that
// boundary wraps the whole console, so the banner's chunk arriving mid-session
// would blank the page the banner is congratulating them on.
const AwaitingApproval = lazy(() => import('./AwaitingApproval'));
const ActivationBanner = lazy(() => import('./ActivationBanner'));

const Waiting = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontSize: '18px',
      color: '#6b7280',
    }}
  >
    Loading...
  </div>
);

/**
 * @param area which mount this guard is protecting. A principal who reaches
 * the wrong mount is REDIRECTED to their own, not 403'd — a wrong-door
 * redirect is better UX, and the server refuses regardless.
 */
export default function ProtectedRoute({
  children,
  area = 'admin',
}: {
  children: ReactNode;
  area?: 'admin' | 'account';
}) {
  const { isAuthenticated, loading, mustChangePassword, accountActivated, user } = useAuth();
  const location = useLocation();
  const [showActivated, setShowActivated] = useState(false);

  // The activation email's `?activated=1`, caught HERE because here is the last
  // place it exists: a signed-out recipient is redirected to the sign-in screen
  // below, and `<Navigate>` does not carry a query string. Stashing it is what
  // lets the banner survive the three redirects between the mailbox and the
  // console. An effect, so it fires whichever branch this render takes.
  useEffect(() => {
    if (isActivationLink(location.search)) rememberActivation();
  }, [location.search]);

  const isCustomer = CUSTOMER_ROLES.includes(user?.role ?? '');
  // Computed up here, above the early returns, because `consoleReady` needs it.
  const wrongDoor = isCustomer ? area === 'admin' : area === 'account';

  // Read-once-and-clear, and ONLY on the render that will actually put a console
  // on screen. Every weaker condition spends it on a component that is about to
  // vanish: the sign-in screen renders no banner, and the sign-in hop lands on
  // /admin first — a DIFFERENT ProtectedRoute element that redirects to /account
  // and unmounts, taking the one-shot with it.
  const consoleReady =
    isAuthenticated &&
    !loading &&
    !mustChangePassword &&
    !wrongDoor &&
    (!isCustomer || accountActivated === true);
  useEffect(() => {
    if (consoleReady && takeActivationNotice()) setShowActivated(true);
  }, [consoleReady]);

  if (loading) {
    return <Waiting />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  // A pending forced reset wins over every console page — the API would 403 them
  // all anyway (auth_service.get_current_user), so nothing behind this renders
  // until the password is changed.
  if (mustChangePassword) {
    return <Navigate to="/admin/change-password" replace />;
  }

  if (wrongDoor) {
    return isCustomer ? (
      <Navigate to="/account" replace state={{ from: location.pathname }} />
    ) : (
      <Navigate to="/admin" replace />
    );
  }

  // D17. The wrong-door redirect runs FIRST so a customer who typed /admin is
  // sent to their own mount and meets this there, at the URL they will bookmark.
  if (isCustomer) {
    // Not activated yet: the console would render in full and then every panel
    // on it would 403 `account_not_activated`, one failure at a time, at
    // somebody who did nothing wrong.
    if (accountActivated === false) {
      // The same "Loading..." the hold below uses, so the chunk arriving is not
      // a second visual state on the way to the first.
      return (
        <Suspense fallback={<Waiting />}>
          <AwaitingApproval />
        </Suspense>
      );
    }
    // Verdict not in yet. HOLDING is the only honest option: rendering the
    // console optimistically is the defect itself, and rendering "awaiting
    // approval" optimistically accuses a customer who is perfectly fine.
    if (accountActivated !== true) {
      return <Waiting />;
    }
  }

  return (
    <>
      {showActivated && (
        <Suspense fallback={null}>
          <ActivationBanner onDismiss={() => setShowActivated(false)} />
        </Suspense>
      )}
      {children}
    </>
  );
}
