// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import {
  handlePreloadError,
  installPreloadErrorRecovery,
} from './preloadErrorRecovery';

// Minimal in-memory Storage stand-in for the sessionStorage seam — keeps the
// decision-logic tests independent of the real (shared) sessionStorage.
function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
  };
}

describe('handlePreloadError — stale-chunk recovery decision', () => {
  it('reloads once and suppresses the default on the first preload failure', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const preventDefault = vi.fn();

    const didReload = handlePreloadError({ preventDefault }, { storage, reload });

    // preventDefault: stop Vite's unhandled rejection from dead-ending at the
    // ErrorBoundary 'This page failed to load' card while we recover.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    // reload: re-fetch the current index.html + chunk hashes (the self-heal).
    expect(reload).toHaveBeenCalledTimes(1);
    expect(didReload).toBe(true);
  });

  it('suppresses the default on every failure but reloads only once per session', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const pd1 = vi.fn();
    const pd2 = vi.fn();

    handlePreloadError({ preventDefault: pd1 }, { storage, reload });
    // A genuinely-broken deploy still 404s after the reload; this is the second
    // chunk miss in the same session.
    const second = handlePreloadError(
      { preventDefault: pd2 },
      { storage, reload },
    );

    // Always suppress the rejection — even when we decline to reload again — so
    // a broken deploy doesn't flash the ErrorBoundary on every later chunk miss.
    expect(pd1).toHaveBeenCalledTimes(1);
    expect(pd2).toHaveBeenCalledTimes(1);
    // ...but the session guard caps it at one reload, so it never loops.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second).toBe(false);
  });

  it('stays fail-open when sessionStorage throws (private mode / disabled)', () => {
    const reload = vi.fn();
    const preventDefault = vi.fn();
    const throwingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };

    // The locked-down browser is this bug's own audience — the handler must not
    // throw inside the global listener, and must still attempt the self-heal.
    expect(() =>
      handlePreloadError(
        { preventDefault },
        { storage: throwingStorage, reload },
      ),
    ).not.toThrow();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('installPreloadErrorRecovery — bootstrap wiring', () => {
  it('registers a vite:preloadError listener that triggers recovery', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const listeners: Record<string, (event: Event) => void> = {};
    const target = {
      addEventListener: (type: string, cb: (event: Event) => void): void => {
        listeners[type] = cb;
      },
    };

    installPreloadErrorRecovery({ target, storage, reload });

    expect(typeof listeners['vite:preloadError']).toBe('function');

    // Simulate Vite firing the event when a lazy chunk 404s.
    listeners['vite:preloadError']({ preventDefault: () => {} } as Event);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('defaults to window + sessionStorage and recovers on a real event', () => {
    sessionStorage.clear();
    localStorage.clear();
    const reload = vi.fn();

    // Inject ONLY reload; target + storage must default to the real browser
    // globals — the exact wiring main.tsx relies on.
    installPreloadErrorRecovery({ reload });

    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);

    // The guard must live in sessionStorage (tab-scoped), NOT localStorage — a
    // localStorage flag would wedge the user across tabs and browser restarts.
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(sessionStorage.length).toBeGreaterThan(0);

    // A second real event in the same session must not reload again (no loop).
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
