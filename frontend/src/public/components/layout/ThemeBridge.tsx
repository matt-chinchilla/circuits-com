import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const KEY_TO_THEME: Record<string, string> = {
  A: "steel",
  B: "schematic",
  C: "pcb",
};

const VALID_THEMES = new Set(["base", "steel", "schematic", "pcb"]);
const STORAGE_KEY = "circuits.nav.theme";

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

  // URL param wins when present (shareable links); otherwise read persisted
  // choice from localStorage. Default = base.
  const fromUrl = key && KEY_TO_THEME[key] ? KEY_TO_THEME[key] : null;
  const theme = fromUrl ?? readPersisted() ?? "base";

  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== theme) {
      root.dataset.theme = theme;
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage disabled (private mode, quota) — URL still works
    }
  }, [theme]);

  return null;
}
