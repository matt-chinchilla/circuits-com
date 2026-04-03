import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface DemoContextValue {
  demoMode: boolean;
  toggleDemo: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

function getInitialMode(): boolean {
  const stored = localStorage.getItem('admin_demo_mode');
  if (stored === 'false') return false;
  return true;
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [demoMode, setDemoMode] = useState(getInitialMode);

  const toggleDemo = useCallback(() => {
    setDemoMode((prev) => {
      const next = !prev;
      localStorage.setItem('admin_demo_mode', String(next));
      return next;
    });
  }, []);

  return (
    <DemoContext.Provider value={{ demoMode, toggleDemo }}>
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
