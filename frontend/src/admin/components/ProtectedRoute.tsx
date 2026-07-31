import { Navigate } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import type { ReactNode } from 'react';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading, mustChangePassword } = useAuth();

  if (loading) {
    return (
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
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  // A pending forced reset wins over every admin page — the API would 403 them
  // all anyway (auth_service.get_current_user), so nothing behind this renders
  // until the password is changed.
  if (mustChangePassword) {
    return <Navigate to="/admin/change-password" replace />;
  }

  return <>{children}</>;
}
