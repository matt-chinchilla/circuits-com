import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const KEY_TO_THEME: Record<string, string> = {
  A: "steel",
  B: "schematic",
  C: "pcb",
};

export default function ThemeBridge() {
  const [params] = useSearchParams();
  const key = params.get("nav");
  const theme = key && KEY_TO_THEME[key] ? KEY_TO_THEME[key] : "base";

  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== theme) {
      root.dataset.theme = theme;
    }
  }, [theme]);

  return null;
}
