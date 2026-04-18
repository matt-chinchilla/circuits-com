import { useSearchParams } from "react-router-dom";
import styles from "./NavVariantPicker.module.scss";

const VARIANTS = [
  { key: "", label: "Base" },
  { key: "A", label: "Steel" },
  { key: "B", label: "Schematic" },
  { key: "C", label: "PCB" },
];

export default function NavVariantPicker() {
  const [params, setParams] = useSearchParams();
  const current = params.get("nav") ?? "";

  return (
    <div className={styles.picker}>
      <span className={styles.label}>Nav</span>
      {VARIANTS.map(({ key, label }) => (
        <button
          key={key || "default"}
          type="button"
          className={`${styles.btn} ${current === key ? styles.active : ""}`}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (!key) next.delete("nav");
            else next.set("nav", key);
            setParams(next, { replace: true });
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
