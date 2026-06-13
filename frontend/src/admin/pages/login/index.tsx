import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import AuthShell from './components/AuthShell';
import SignIn from './screens/SignIn';
import ForgotPassword from './screens/ForgotPassword';
import ForgotUsername from './screens/ForgotUsername';
import type { Screen } from './screens/types';

export default function LoginPage() {
  const { isAuthenticated, loading } = useAuth();
  const [screen, setScreen] = useState<Screen>('signin');

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
    return <Navigate to="/admin" replace />;
  }

  return (
    <AuthShell>
      {screen === 'signin' && <SignIn go={setScreen} />}
      {screen === 'forgot-password' && <ForgotPassword go={setScreen} />}
      {screen === 'forgot-username' && <ForgotUsername go={setScreen} />}
    </AuthShell>
  );
}
