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
import { activationFromProbe, type AccountMe } from '@admin/services/accountActivation';
import { passwordGate } from '@admin/services/passwordGate';
import type { AuthResponse, UserInfo } from '@admin/types/admin';

/**
 * Roles that belong on the CUSTOMER mount — the same list ProtectedRoute
 * guards on, and the only accounts activation applies to (`activated_at` is
 * NULL on every staff row and must stay irrelevant to them).
 */
const CUSTOMER_ROLES = ['user'];

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
  /**
   * D17: has staff activated this customer's account yet?
   *
   * `null` means the question does not apply or has no answer yet — a staff
   * account, a signed-out visitor, or a customer whose probe is still in
   * flight. ProtectedRoute HOLDS on null rather than guessing: rendering the
   * console optimistically is the defect (every panel 403s), and rendering
   * "awaiting approval" optimistically accuses a good customer.
   */
  accountActivated: boolean | null;
  /**
   * True when this session belongs to the CUSTOMER mount — the same
   * CUSTOMER_ROLES list ProtectedRoute routes on. Derived here rather than
   * re-spelled as `user?.role === 'user'` at each call site, because the
   * console is one component tree at two mounts (D16) and every customer-only
   * branch in it has to agree about who a customer is.
   */
  isCustomer: boolean;
  /**
   * GET /api/account/me for a CUSTOMER — identity, activation, and the two
   * capability links. `null` for staff, for a signed-out visitor, and while
   * the probe is in flight.
   *
   * The probe already fetches this body to answer the activation question, so
   * keeping it costs nothing and saves every console page a second round trip
   * to ask what kind of company this is. Capability is `is_supplier` and
   * `is_manufacturer`, INDEPENDENTLY: both set is the normal case for the
   * largest players and neither set is the free browsing account, so a reader
   * that treats them as one enum has already got Avnet wrong.
   */
  account: AccountMe | null;
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
  const [accountActivated, setAccountActivated] = useState<boolean | null>(null);
  const [account, setAccount] = useState<AccountMe | null>(null);
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

  // The activation probe (D17). Runs for CUSTOMERS ONLY, once per identity.
  //
  // GET /api/account/me is gated on require_account_user, so the answer itself
  // is the flag: a 200 means activated, a 403 `account_not_activated` means not.
  // Keyed on the user's id and role rather than the object, so a re-render that
  // hands back an equal-but-new `user` does not re-probe.
  useEffect(() => {
    if (!CUSTOMER_ROLES.includes(user?.role ?? '')) {
      // Staff, or nobody. There is no question to answer.
      setAccountActivated(null);
      setAccount(null);
      return;
    }
    let cancelled = false;
    setAccountActivated(null);
    setAccount(null);
    adminApi
      .getAccountMe()
      .then((me) => {
        if (cancelled) return;
        setAccountActivated(activationFromProbe({ ok: true, body: me }));
        // The body itself, not just the verdict read off it. A page asking
        // "am I a distributor?" is asking this same call; throwing the answer
        // away meant every one of them fetched it again.
        setAccount(me);
      })
      .catch((err) => {
        if (cancelled) return;
        const response = err?.response;
        setAccountActivated(
          activationFromProbe({
            ok: false,
            status: response?.status,
            detail: response?.data?.detail,
          }),
        );
        // No body, so no capability. Chrome and pages fall back to the
        // unlinked shape, which is the right answer when nothing is known —
        // never a guess at what this account might be.
        setAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role]);

  // Same list the probe keys on, so "is this a customer" has one answer per
  // render rather than one per reader.
  const isCustomer = CUSTOMER_ROLES.includes(user?.role ?? '');

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
    // The activation verdict and the account body clear themselves:
    // setUser(null) re-runs the probe effect, which finds no customer and
    // resets both. Mutation-checked — an explicit setAccountActivated(null)
    // here changed nothing, so it is not here, and `account` is reset on the
    // same line. The next person to sign in on this tab inherits nothing.
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        loading,
        mustChangePassword,
        accountActivated,
        isCustomer,
        account,
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
