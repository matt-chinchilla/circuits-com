import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import type { ReactNode } from 'react';

/**
 * Roles that belong on the CUSTOMER mount. Matches the `user_role` enum in
 * api/app/models/user.py, where a customer is `user` (renamed from `company`
 * by alembic 043); `admin` and `owner` are staff.
 */
const CUSTOMER_ROLES = ['user'];

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
  const { isAuthenticated, loading, mustChangePassword, user } = useAuth();
  const location = useLocation();

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

  // A pending forced reset wins over every console page — the API would 403 them
  // all anyway (auth_service.get_current_user), so nothing behind this renders
  // until the password is changed.
  if (mustChangePassword) {
    return <Navigate to="/admin/change-password" replace />;
  }

  const isCustomer = CUSTOMER_ROLES.includes(user?.role ?? '');
  if (isCustomer && area === 'admin') {
    return <Navigate to="/account" replace state={{ from: location.pathname }} />;
  }
  if (!isCustomer && area === 'account') {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}
