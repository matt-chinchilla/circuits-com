import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const KEY_TO_THEME: Record<string, string> = {
  A: "steel",
  B: "schematic",
  C: "pcb",
};

const VALID_THEMES = new Set(["base", "steel", "schematic", "pcb"]);
const STORAGE_KEY = "circuits.nav.theme";
const DEFAULT_THEME = "steel";

function readPersisted(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && VALID_THEMES.has(stored) ? stored : null;
  } catch {
    return null;
  }
}

export default function ThemeBridge() {
  const [params] = useSearchParams();
  const key = params.get("nav");

  // Prod: steel is the definitive theme. URL params + localStorage ignored so
  // users (and stale localStorage from prior visits) can't get stuck on a
  // non-steel theme — the NavVariantPicker isn't shipped to prod so there's
  // no UI to switch back. Dev: full resolution (URL → localStorage → steel
  // fallback) so the picker still works for visual QA.
  let theme: string;
  if (import.meta.env.DEV) {
    const fromUrl = key && KEY_TO_THEME[key] ? KEY_TO_THEME[key] : null;
    theme = fromUrl ?? readPersisted() ?? DEFAULT_THEME;
  } else {
    theme = DEFAULT_THEME;
  }

  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== theme) {
      root.dataset.theme = theme;
    }
    if (import.meta.env.DEV) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // localStorage disabled (private mode, quota) — URL still works
      }
    }
  }, [theme]);

  return null;
}
