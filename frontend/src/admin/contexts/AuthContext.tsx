import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { adminApi } from '@admin/services/adminApi';
import { passwordGate } from '@admin/services/passwordGate';
import type { AuthResponse, UserInfo } from '@admin/types/admin';

interface AuthContextValue {
  user: UserInfo | null;
  isAuthenticated: boolean;
  loading: boolean;
  /**
   * True while this account owes a forced password reset. ProtectedRoute routes
   * to /admin/change-password on it, and the adminApi interceptor raises it
   * from a 403 `password_change_required` on ANY admin request.
   */
  mustChangePassword: boolean;
  /** Sign in with the EMAIL address — there is no username login. */
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  /** Change the password and adopt the fresh token the server hands back. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // External store, not React state: the 403 that raises this flag is caught in
  // an axios interceptor, which has no way to reach a context.
  const mustChangePassword = useSyncExternalStore(passwordGate.subscribe, passwordGate.isRequired);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('admin_token');
    if (!token) {
      setLoading(false);
      return;
    }
    adminApi
      .getMe()
      .then((me) => {
        if (cancelled) return;
        // /auth/me is ungated on purpose — a flagged user must be able to ask
        // who they are, which is how a reloaded tab rediscovers the screen.
        passwordGate.set(Boolean(me.must_change_password));
        setUser(me);
      })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem('admin_token');
        passwordGate.set(false);
        setUser(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One place where a login-shaped payload becomes a session — /auth/login and
  // /auth/change-password both funnel through here so a token is never stored
  // two slightly different ways.
  const adopt = useCallback((response: AuthResponse) => {
    localStorage.setItem('admin_token', response.token);
    passwordGate.set(Boolean(response.must_change_password));
    setUser(response.user);
  }, []);

  const login = useCallback(
    async (email: string, password: string, remember = false) => {
      adopt(await adminApi.login(email, password, remember));
    },
    [adopt],
  );


  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      // The fresh token matters: stamping password_changed_at server-side
      // retires the token we authenticated this very call with.
      adopt(await adminApi.changePassword(currentPassword, newPassword));
    },
    [adopt],
  );

  const logout = useCallback(() => {
    localStorage.removeItem('admin_token');
    passwordGate.set(false);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        loading,
        mustChangePassword,
        login,
        changePassword,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
