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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return null;
}
