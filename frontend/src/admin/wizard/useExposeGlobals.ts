import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { cachedSponsors } from '@admin/services/sponsorStore';
import { loadMessages } from '@admin/services/messageStore';
import type { WizardStoreSnapshot } from './types';

// Expose two helpers on `window` so external tooling — the wizard itself,
// chrome-devtools-mcp test harnesses, and power-user dev-console scripts —
// can drive admin navigation and read store snapshots without needing to
// be inside the React tree.
//
// __adminGetStore is intentionally narrow. Only sponsors + messages have
// synchronous client caches (last-fetched snapshots); suppliers/parts/imports
// live on the API and would require an async fetch to surface accurately.
// Flows that need those signals use DOM-based polling instead (e.g. "wait
// until the new row appears in the parts table").
//
// Mount in AdminLayout once. The effect captures useNavigate() in the
// closure and assigns it to window. Cleanup removes the binding on unmount.
export function useExposeGlobals(): void {
  const navigate = useNavigate();

  useEffect(() => {
    window.__adminNavigate = (path: string) => {
      try {
        navigate(path);
      } catch {
        // Defensive — navigate can throw if the path isn't in the route tree.
      }
    };

    window.__adminGetStore = (): WizardStoreSnapshot => {
      const sponsors = cachedSponsors().map((s) => ({ id: s.id, tier: s.tier }));
      const messages = loadMessages().map((m) => ({ id: m.id, status: m.status }));
      return {
        suppliers: [],
        parts: [],
        sponsors,
        messages,
        imports: [],
      };
    };

    return () => {
      delete window.__adminNavigate;
      delete window.__adminGetStore;
    };
  }, [navigate]);
}
