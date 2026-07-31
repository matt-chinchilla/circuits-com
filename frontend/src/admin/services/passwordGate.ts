/**
 * The client-side mirror of the server's forced-password-change gate.
 *
 * The API is the real enforcement point: a flagged user gets
 * `403 { detail: "password_change_required" }` from EVERY admin route (see
 * `auth_service.get_current_user`). This module is the one place the admin SPA
 * remembers that answer, so the screen can be shown from three different
 * discoveries of the same fact:
 *
 *   1. `POST /auth/login`  → `must_change_password: true` in the response
 *   2. `GET  /auth/me`     → same flag, on a page reload with a stored token
 *   3. ANY admin request   → the 403 above, caught in the adminApi interceptor
 *
 * It is a tiny external store rather than React state because (3) happens
 * inside an axios interceptor — a module, not a component — which has no way
 * to reach a context. `AuthContext` subscribes and re-renders; `ProtectedRoute`
 * reads it from there and routes to /admin/change-password.
 */

/**
 * The EXACT 403 detail string the backend sends
 * (`auth_service.PASSWORD_CHANGE_REQUIRED_DETAIL`). Matched verbatim so an
 * ordinary permissions 403 can never be mistaken for a forced reset.
 */
export const PASSWORD_CHANGE_REQUIRED_DETAIL = 'password_change_required';

type Listener = () => void;

let required = false;
const listeners = new Set<Listener>();

export const passwordGate = {
  /** getSnapshot for useSyncExternalStore — a stable primitive. */
  isRequired: (): boolean => required,

  /** Set the flag; no-ops (and notifies nobody) when it hasn't changed. */
  set(next: boolean): void {
    if (required === next) return;
    required = next;
    for (const listener of [...listeners]) listener();
  },

  /** subscribe for useSyncExternalStore; returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** True when this axios error is the backend's forced-password-change 403. */
export function isPasswordChangeRequired(status: unknown, detail: unknown): boolean {
  return status === 403 && detail === PASSWORD_CHANGE_REQUIRED_DETAIL;
}
