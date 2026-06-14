// Stale-lazy-chunk recovery for the SPA.
//
// Public routes are code-split into content-hashed chunks (App.tsx — every
// `lazy(() => import(...))`). A frontend deploy emits NEW hashes and DELETES the
// old chunk files (assets are served `immutable`). A client still holding a
// pre-deploy index.html / module graph — most often a tab left open across the
// deploy — then dynamic-imports an old chunk hash that now 404s, so the
// `import()` rejects. Without a handler, that rejection dead-ends at the
// ErrorBoundary ('This page failed to load') and the only escape is a manual
// hard-refresh / browser-cache reset (the symptom a returning coworker hit on
// /contact, 2026-06-14). Vite fires `vite:preloadError` on exactly this
// failure; we convert it into a single recovery reload, which re-fetches the
// current index.html (served `no-cache`) and its current chunk hashes.

const RELOAD_FLAG = 'circuits.preloadReloaded';

export interface PreloadRecoveryDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
}

// Only the one method we use, picked off Window so both the real `window` and a
// test fake satisfy it without a cast.
type ListenerTarget = Pick<Window, 'addEventListener'>;

export interface PreloadRecoveryEnv extends PreloadRecoveryDeps {
  target: ListenerTarget;
}

// sessionStorage access can THROW (Safari private mode, enterprise-locked
// browsers, cookie-blocked iframes) — and that population is precisely the one
// that hits the stale-chunk bug. Read/write fail-open so the handler never
// throws inside the global listener and still attempts the heal.
function hasReloaded(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(RELOAD_FLAG) !== null;
  } catch {
    return false;
  }
}

function markReloaded(storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(RELOAD_FLAG, '1');
  } catch {
    // Storage unavailable — best effort. We still reload once below; bounding
    // the reload then relies on the deploy healing (a genuinely-broken deploy
    // AND dead storage is the one case the session guard can't cap on its own —
    // the console.warn below keeps it diagnosable).
  }
}

/**
 * Decide and act on a single preload/chunk-load failure. Returns true if it
 * triggered a recovery reload, false if it suppressed a repeat.
 */
export function handlePreloadError(
  event: { preventDefault(): void; payload?: unknown },
  { storage, reload }: PreloadRecoveryDeps,
): boolean {
  // Always suppress first: even when we decline to reload again, we don't want
  // the rejection surfacing the ErrorBoundary on every later chunk miss.
  event.preventDefault();

  const willReload = !hasReloaded(storage);
  // Breadcrumb for `docker logs frontend` + DevTools. This handler pre-empts
  // the ErrorBoundary's own console.error, so without this line a stale-chunk
  // (or genuinely-broken-deploy) failure would be log-silent. `payload` is
  // Vite's original import() rejection.
  console.warn(
    `[preloadRecovery] lazy-chunk load failed — ${
      willReload
        ? 'reloading once to self-heal'
        : 'already reloaded this session, staying put'
    }`,
    event.payload,
  );
  if (!willReload) return false;

  // Reload AT MOST ONCE per tab session. The fresh index.html resolves the
  // stale chunk hashes; the sessionStorage guard stops an infinite reload loop
  // when a reload does NOT fix it (a genuinely-broken deploy) — the second
  // failure then falls through and the app stays rendered.
  markReloaded(storage);
  reload();
  return true;
}

/**
 * Wire the recovery handler. Call ONCE at app bootstrap (main.tsx), before
 * React renders, so the listener is live when any lazy route import fires.
 * Deps default to the real browser globals; all three are injectable for tests.
 */
export function installPreloadErrorRecovery(
  env: Partial<PreloadRecoveryEnv> = {},
): void {
  // Best-effort + bootstrap-safe: this runs before React mounts, so a throw
  // from accessing window.sessionStorage / window.location on a hardened
  // browser must NOT white-screen the app over a recovery feature.
  try {
    const target = env.target ?? window;
    const storage = env.storage ?? window.sessionStorage;
    const reload = env.reload ?? (() => window.location.reload());

    target.addEventListener('vite:preloadError', (event) => {
      handlePreloadError(event, { storage, reload });
    });
  } catch {
    // Couldn't install recovery (storage/location access denied) — the app
    // still renders; we simply forgo the auto-reload on this hardened client.
  }
}
