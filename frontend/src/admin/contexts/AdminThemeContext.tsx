import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { applyChartChrome } from '@admin/components/charts/chartTheme';

// Admin-only light/dark theme. The public site keeps its own (steel-locked)
// theme system — this never touches it. The choice is stamped on
// <html data-admin-theme="…">, which the admin SCSS reads for its dark `--a-*`
// token overrides, and mirrored into the chart chrome (the canvas can't read
// CSS vars) via applyChartChrome().

type AdminTheme = 'light' | 'dark';

interface AdminThemeValue {
  theme: AdminTheme;
  toggleTheme: () => void;
}

const AdminThemeContext = createContext<AdminThemeValue | null>(null);

function getInitial(): AdminTheme {
  return localStorage.getItem('admin_theme') === 'dark' ? 'dark' : 'light';
}

// Stamp <html> + swap chart chrome SYNCHRONOUSLY, so the very first paint (and
// any chart built during it) already matches the stored theme.
function applyTheme(theme: AdminTheme): void {
  document.documentElement.dataset.adminTheme = theme;
  applyChartChrome(theme === 'dark');
}

export function AdminThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<AdminTheme>(() => {
    const initial = getInitial();
    applyTheme(initial);
    return initial;
  });

  // Re-apply on mount AND on every change. The initializer stamp above covers the
  // first paint (so charts init with the right chrome), but a browser back/forward
  // that re-mounts the provider — or React StrictMode's setup/cleanup/setup in dev —
  // needs this to RE-stamp <html> + chart chrome after the unmount cleanup ran.
  // Without it, going back into /admin (or dev double-invoke) silently reverts to light.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    // Leaving the admin SPA — drop the attribute so it can't tint anything else.
    return () => {
      delete document.documentElement.dataset.adminTheme;
      applyChartChrome(false);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: AdminTheme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('admin_theme', next);
      // Apply BEFORE the state commit re-renders + remounts the themed content,
      // so rebuilt options and re-registered chart themes read the new chrome.
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <AdminThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </AdminThemeContext.Provider>
  );
}

export function useAdminTheme(): AdminThemeValue {
  const ctx = useContext(AdminThemeContext);
  if (!ctx) {
    throw new Error('useAdminTheme must be used within an AdminThemeProvider');
  }
  return ctx;
}
