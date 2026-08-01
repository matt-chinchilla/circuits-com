import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@admin/contexts/AuthContext';

interface DemoContextValue {
  demoMode: boolean;
  toggleDemo: () => void;
  /**
   * True when DEMO DATA is forced on and cannot be switched off — the public
   * demo account. `toggleDemo` is a no-op while this is set; the topbar switch
   * renders disabled rather than silently ignoring clicks.
   */
  demoLocked: boolean;
}

const DemoContext = createContext<DemoContextValue | null>(null);

function getInitialMode(): boolean {
  const stored = localStorage.getItem('admin_demo_mode');
  if (stored === 'false') return false;
  return true;
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState(getInitialMode);
  // Server-signalled, not inferred: /auth/login and /auth/me both stamp
  // `is_demo` (auth_service.is_demo_user). A prospect who reached the console
  // through the "See Demo" button must see synthetic figures — real revenue,
  // customer names and sponsor contacts are not for an anonymous visitor —
  // so the stored preference is overridden rather than consulted.
  const { user } = useAuth();
  const demoLocked = Boolean(user?.is_demo);

  const toggleDemo = useCallback(() => {
    if (demoLocked) return;
    setStored((prev) => {
      const next = !prev;
      localStorage.setItem('admin_demo_mode', String(next));
      return next;
    });
  }, [demoLocked]);

  // NOTE the write to localStorage stays inside toggleDemo: a locked session
  // must not persist "demo on" into the browser of someone who later signs in
  // as a real admin on the same machine.
  const demoMode = demoLocked || stored;

  return (
    <DemoContext.Provider value={{ demoMode, toggleDemo, demoLocked }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) {
    throw new Error('useDemo must be used within a DemoProvider');
  }
  return ctx;
}
