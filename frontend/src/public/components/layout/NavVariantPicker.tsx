import { useSearchParams } from "react-router-dom";
import styles from "./NavVariantPicker.module.scss";

const VARIANTS = [
  { key: "", theme: "base", label: "Base" },
  { key: "A", theme: "steel", label: "Steel" },
  { key: "B", theme: "schematic", label: "Schematic" },
  { key: "C", theme: "pcb", label: "PCB" },
] as const;

const STORAGE_KEY = "circuits.nav.theme";

function readCurrentTheme(params: URLSearchParams): string {
  const urlKey = params.get("nav");
  const fromUrl = VARIANTS.find((v) => v.key && v.key === urlKey)?.theme;
  if (fromUrl) return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VARIANTS.some((v) => v.theme === stored)) return stored;
  } catch {
    // localStorage disabled — fall through to base
  }
  return "base";
}

export default function NavVariantPicker() {
  const [params, setParams] = useSearchParams();
  const currentTheme = readCurrentTheme(params);

  return (
    <div className={styles.picker}>
      <span className={styles.label}>Nav</span>
      {VARIANTS.map(({ key, theme, label }) => (
        <button
          key={theme}
          type="button"
          className={`${styles.btn} ${currentTheme === theme ? styles.active : ""}`}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (!key) next.delete("nav");
            else next.set("nav", key);
            // Overwrite localStorage immediately so clicking Base
            // (which clears the URL param) isn't shadowed by the
            // previously persisted non-base choice.
            try {
              localStorage.setItem(STORAGE_KEY, theme);
            } catch {
              // localStorage disabled — URL param will still drive it
            }
            setParams(next, { replace: true });
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
