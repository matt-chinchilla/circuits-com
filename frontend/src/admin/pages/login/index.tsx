import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import AuthShell from './components/AuthShell';
import SignIn from './screens/SignIn';
import ForgotPassword from './screens/ForgotPassword';
import SignUp from './screens/SignUp';
import type { Screen } from './screens/types';

export default function LoginPage() {
  const { isAuthenticated, loading, mustChangePassword } = useAuth();
  const { pathname } = useLocation();
  // /admin/signup is this same shell opened on its sign-up screen — the route
  // is what the "Sign Up" links in email and marketing point at, so it must
  // land on the form rather than on sign-in. Initial state only: `go` swaps
  // screens in place afterwards and the URL deliberately does not follow.
  const [screen, setScreen] = useState<Screen>(
    pathname === '/admin/signup' ? 'signup' : 'signin',
  );

  if (loading) {
    // Keep the branded shell up while the token check runs — no flash of an
    // empty card or a layout jump into the form.
    return (
      <AuthShell>
        <div className="screen" aria-busy="true" />
      </AuthShell>
    );
  }

  if (isAuthenticated) {
    // A flagged account goes straight to the forced-reset screen — ProtectedRoute
    // would bounce it there anyway; this just skips the extra hop.
    return <Navigate to={mustChangePassword ? '/admin/change-password' : '/admin'} replace />;
  }

  return (
    <AuthShell>
      {screen === 'signin' && <SignIn go={setScreen} />}
      {screen === 'forgot-password' && <ForgotPassword go={setScreen} />}
      {screen === 'signup' && <SignUp go={setScreen} />}
    </AuthShell>
  );
}
