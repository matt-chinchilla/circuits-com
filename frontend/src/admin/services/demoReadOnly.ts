/**
 * The client-side face of the server's read-only demo gate.
 *
 * The API is the real enforcement point: the public demo account gets
 * `403 { detail: "demo_account_read_only" }` from EVERY mutating admin route
 * (see `auth_service.get_current_user`). Nothing here protects any data — this
 * module exists so the console can answer that 403 with a friendly sentence
 * instead of a raw error, from wherever it happens to be caught.
 *
 * Shaped exactly like `passwordGate` for the same reason: the 403 arrives in an
 * axios interceptor — a module, not a component — which has no way to reach a
 * React context. `AdminLayout` subscribes via `useSyncExternalStore`.
 */

/**
 * The EXACT 403 detail string the backend sends
 * (`auth_service.DEMO_READ_ONLY_DETAIL`). Matched verbatim so an ordinary
 * permissions 403 can never be mistaken for the demo gate.
 */
export const DEMO_READ_ONLY_DETAIL = 'demo_account_read_only';

/** What the user reads. One sentence, no jargon, no error code. */
export const DEMO_READ_ONLY_MESSAGE = 'Editing is disabled in the demo.';

/** True when this axios error is the backend's read-only-demo 403. */
export function isDemoReadOnly(status: unknown, detail: unknown): boolean {
  return status === 403 && detail === DEMO_READ_ONLY_DETAIL;
}

/**
 * "Is the CURRENT session the demo account?" as a module-level flag.
 *
 * Mirrors `user.is_demo` (which the SERVER stamps on /auth/login and /auth/me)
 * so plain modules — not just components — can consult it. `AuthContext` is the
 * only writer.
 *
 * It guards nothing: the server refuses every demo write regardless. Its job is
 * to stop the console FIRING background writes it knows will be refused —
 * chiefly `messageStore`'s fire-and-forget "mark read" PATCH, which would
 * otherwise pop "Editing is disabled in the demo" at a prospect who merely
 * OPENED a message.
 */
let sessionIsDemo = false;

export const demoSession = {
  isDemo: (): boolean => sessionIsDemo,
  set(next: boolean): void {
    sessionIsDemo = next;
  },
};

type Listener = () => void;

// A COUNTER, not a boolean: the notice auto-hides, and a second blocked edit
// after that has to be able to show it again. `useSyncExternalStore` needs a
// stable primitive snapshot, and a monotonically increasing number gives the
// subscriber a change to react to every single time (0 = never raised).
let sequence = 0;
const listeners = new Set<Listener>();

export const demoReadOnlyNotice = {
  /** getSnapshot for useSyncExternalStore — increments on every refusal. */
  getSequence: (): number => sequence,

  /** Record one refused edit; wakes every subscriber. */
  raise(): void {
    sequence += 1;
    for (const listener of [...listeners]) listener();
  },

  /** subscribe for useSyncExternalStore; returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Test seam only — resets the counter so cases don't leak into each other. */
  reset(): void {
    sequence = 0;
    listeners.clear();
    sessionIsDemo = false;
  },
};
