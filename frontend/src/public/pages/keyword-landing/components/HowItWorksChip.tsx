import { useEffect, useRef, useState } from 'react';
import type { HowStep } from '../constants';
import styles from './HowItWorksChip.module.scss';

// HowItWorksChip — IC chip pin-out diagram visualizing the 3-step onboarding
// flow. V2 design parity (2026-05-14): 15 pins on TOP and 15 pins on BOTTOM
// (continuous, space-around across the full body width). Three of the BOTTOM
// pins are "live" (theme-accent gradient + glow) at indices 2, 7, 12 — which
// sit at exactly 1/6, 1/2, and 5/6 of body width. The step cards below match
// those fractions, so each vertical trace drops straight down dead-center
// onto its card's contact pad.
//
// `space-around` (not `space-evenly`) puts item centers at exactly
// (i+0.5)/N of width — `space-evenly` adds an N+1th gap at the edges which
// pulls outer items inward and breaks the 1/6 · 1/2 · 5/6 alignment.
//
// IntersectionObserver triggers the draw animation once on scroll-into-view;
// the static drop-shadow filter on the trace is OK because only
// stroke-dashoffset animates (per CLAUDE.md no-animated-drop-shadow rule).

interface HowItWorksChipProps {
  steps: readonly HowStep[];
}

const PINS_PER_ROW = 15;
const LIVE_PIN_INDICES = [2, 7, 12]; // 1/6, 1/2, 5/6 of pin-row width

export default function HowItWorksChip({ steps }: HowItWorksChipProps) {
  const [drawn, setDrawn] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setDrawn(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      className={`${styles.howChip} ${drawn ? styles.drawn : ''}`}
      ref={wrapRef}
    >
      <div className={styles.howChipStage}>
        {/* IC body — 15-pin top + 15-pin bottom layout */}
        <div className={styles.howChipBody} aria-hidden="true">
          <span className={styles.howChipMarking}>CIRCUIT CENTER · KW-SPONSOR</span>
          <span className={styles.howChipPin1Dot} aria-hidden="true" />
          <div className={`${styles.howChipPinRow} ${styles.pinRowTop}`}>
            {Array.from({ length: PINS_PER_ROW }).map((_, i) => (
              <span
                key={i}
                className={`${styles.howChipPin} ${LIVE_PIN_INDICES.includes(i) ? styles.live : ''}`}
                data-pin={i + 1}
              />
            ))}
          </div>
          <div className={`${styles.howChipPinRow} ${styles.pinRowBottom}`}>
            {Array.from({ length: PINS_PER_ROW }).map((_, i) => (
              <span
                key={i}
                className={`${styles.howChipPin} ${LIVE_PIN_INDICES.includes(i) ? styles.live : ''}`}
                data-pin={i + PINS_PER_ROW + 1}
              />
            ))}
          </div>
        </div>

        {/* Trace row — single SVG that spans the full body width. Three
            straight vertical traces at viewBox x = 100, 300, 500 (which
            are 1/6, 1/2, 5/6 of the 600-unit viewBox). preserveAspectRatio
            = none stretches with the parent so the fractions are preserved
            at any width. */}
        <div className={styles.howChipTraceRow} aria-hidden="true">
          <svg
            className={styles.howChipTracesSvg}
            viewBox="0 0 600 80"
            preserveAspectRatio="none"
          >
            {[100, 300, 500].map((x, i) => (
              <g key={i}>
                <path
                  className={styles.howChipTrace}
                  d={`M ${x} 0 L ${x} 80`}
                  style={{ transitionDelay: `${i * 180}ms` }}
                />
                <circle
                  className={styles.howChipNode}
                  cx={x}
                  cy={74}
                  r="4"
                  style={{ transitionDelay: `${i * 180 + 200}ms` }}
                />
              </g>
            ))}
          </svg>
        </div>

        {/* Step cards — 3-col grid with NO column gap, so column centers
            stay at 1/6, 1/2, 5/6 of width. Each card gets symmetric 14px
            horizontal margin to create the 28px visual gap while keeping
            its center on the column center. */}
        <div className={styles.howChipSteps}>
          {steps.map((s, i) => (
            <article
              key={s.num}
              className={styles.howChipStep}
              style={{ transitionDelay: `${i * 180 + 300}ms` }}
            >
              <span className={styles.howChipStepPin}>STEP {i + 1}</span>
              <span className={styles.howChipStepNum}>{s.num}</span>
              <h3 className={styles.howChipStepTitle}>{s.title}</h3>
              <p className={styles.howChipStepDesc}>{s.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
