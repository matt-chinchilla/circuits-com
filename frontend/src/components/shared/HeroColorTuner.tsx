// frontend/src/components/shared/HeroColorTuner.tsx
import { useEffect, useState } from "react";
import styles from "./HeroColorTuner.module.scss";

const STORAGE_PREFIX = "circuits.tuner.";

type Slot = "ic-body-fill" | "ic-body-stroke" | "ic-pad-fill";

const DEFAULTS: Record<Slot, number> = {
  "ic-body-fill": 3,
  "ic-body-stroke": 15,
  "ic-pad-fill": 30,
};

const LABELS: Record<Slot, string> = {
  "ic-body-fill": "IC body fill",
  "ic-body-stroke": "IC body stroke",
  "ic-pad-fill": "IC pad fill",
};

function readInitial(slot: Slot): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + slot);
    if (raw === null) return DEFAULTS[slot];
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULTS[slot];
  } catch {
    return DEFAULTS[slot];
  }
}

function colorMixString(percent: number): string {
  return `color-mix(in srgb, var(--theme-pcb-trace) ${percent}%, transparent)`;
}

function applySlot(slot: Slot, percent: number): void {
  document.documentElement.style.setProperty(`--${slot}`, colorMixString(percent));
  try {
    localStorage.setItem(STORAGE_PREFIX + slot, String(percent));
  } catch {
    // localStorage disabled — live override still works via document.documentElement
  }
}

function clearAll(): void {
  for (const slot of Object.keys(DEFAULTS) as Slot[]) {
    document.documentElement.style.removeProperty(`--${slot}`);
    try {
      localStorage.removeItem(STORAGE_PREFIX + slot);
    } catch {
      // noop
    }
  }
}

export default function HeroColorTuner() {
  if (!import.meta.env.DEV) return null;

  const [values, setValues] = useState<Record<Slot, number>>({
    "ic-body-fill": readInitial("ic-body-fill"),
    "ic-body-stroke": readInitial("ic-body-stroke"),
    "ic-pad-fill": readInitial("ic-pad-fill"),
  });

  // Apply any persisted overrides on first render.
  useEffect(() => {
    (Object.keys(values) as Slot[]).forEach((slot) => {
      if (values[slot] !== DEFAULTS[slot]) applySlot(slot, values[slot]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (slot: Slot) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setValues((prev) => ({ ...prev, [slot]: v }));
    applySlot(slot, v);
  };

  const onReset = () => {
    clearAll();
    setValues({ ...DEFAULTS });
  };

  return (
    <div className={styles.tuner}>
      <div className={styles.header}>
        <span className={styles.title}>Hero Tuner</span>
        <button type="button" onClick={onReset} className={styles.reset}>
          Reset
        </button>
      </div>
      {(Object.keys(DEFAULTS) as Slot[]).map((slot) => (
        <div key={slot} className={styles.row}>
          <label className={styles.label}>
            <span className={styles.name}>{LABELS[slot]}</span>
            <span className={styles.value}>{values[slot]}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={values[slot]}
            onChange={onChange(slot)}
            className={styles.slider}
          />
          <code className={styles.readout}>{colorMixString(values[slot])}</code>
        </div>
      ))}
    </div>
  );
}
