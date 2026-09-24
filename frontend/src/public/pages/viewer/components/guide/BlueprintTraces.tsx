// The traces between the folder and the outputs: one net per kind of file
// (project, sheets, board), routed like PCB copper — horizontal, a 45° chamfer,
// vertical, a chamfer, horizontal — with a KiCad-style net label at each
// junction and a copper pad at every end.
//
// Computed from the LIVE boxes of the rows and cards (`data-net-src` /
// `data-net-dst`, with `data-trace-left` / `data-trace-right` marking the two
// column edges), so the drawing stays true at any width. Below 1100px the SVG
// is `display: none` and nothing is measured; the cards' "from …" line carries
// the mapping there.
//
// Motion: ONE orchestrated moment — the nets draw in on the first layout,
// staggered — after which the drawing is SETTLED and a relayout (resize, the
// guide reopening) redraws without replaying. Hover lights one net; a drag over
// the sheet lights all three. prefers-reduced-motion: drawn and static.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { NET_LABEL, type Net } from './guideCopy';
import styles from './Guide.module.scss';

const NETS: readonly Net[] = ['pro', 'sch', 'pcb'];
const DELAY_S: Record<Net, number> = { pro: 0, sch: 0.25, pcb: 0.5 };
/** Where each net's junction sits across the gap, as a fraction of it. */
const BUS: Record<Net, number> = { pro: 0.36, sch: 0.5, pcb: 0.64 };
/** First draw + pads + one pulse, then the drawing holds still. */
const SETTLE_MS = 2600;

interface NetGeometry {
  net: Net;
  paths: string[];
  pads: { x: number; y: number }[];
  label: { x: number; y: number; w: number };
}

/** PCB-style route with 45° chamfers. */
export function route(x1: number, y1: number, x2: number, y2: number, xm: number): string {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) return `M${x1} ${y1}H${x2}`;
  const s = Math.sign(dy);
  const c = Math.min(10, Math.abs(dy) / 2);
  return `M${x1} ${y1}H${xm - c}L${xm} ${y1 + s * c}V${y2 - s * c}L${xm + c} ${y2}H${x2}`;
}

function measure(sheet: HTMLElement): NetGeometry[] {
  const R = sheet.getBoundingClientRect();
  const left = sheet.querySelector<HTMLElement>('[data-trace-left]');
  const right = sheet.querySelector<HTMLElement>('[data-trace-right]');
  if (left == null || right == null) return [];
  const x0 = left.getBoundingClientRect().right - R.left;
  const xOut = right.getBoundingClientRect().left - R.left;
  const span = xOut - x0;
  if (span < 120) return [];
  const midY = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.top - R.top + r.height / 2;
  };
  const out: NetGeometry[] = [];
  for (const net of NETS) {
    const srcs = [...sheet.querySelectorAll(`[data-net-src][data-net="${net}"]`)].map(midY);
    const dsts = [...sheet.querySelectorAll(`[data-net-dst][data-net="${net}"]`)].map(midY);
    if (srcs.length === 0 || dsts.length === 0) continue;
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const jy = (avg(srcs) + avg(dsts)) / 2;
    const jx = x0 + span * BUS[net];
    const paths = [
      ...srcs.map((y) => route(x0 + 6, y, jx - 34, jy, jx - 48)),
      ...dsts.map((y) => route(jx + 34, jy, xOut - 6, y, jx + 48)),
      `M${jx - 34} ${jy}H${jx + 34}`,
    ];
    const pads = [...srcs.map((y) => ({ x: x0 + 6, y })), ...dsts.map((y) => ({ x: xOut - 6, y }))];
    out.push({ net, paths, pads, label: { x: jx, y: jy, w: NET_LABEL[net].length * 7 + 14 } });
  }
  return out;
}

interface Props {
  /** The guide is open — closed, the folder and outputs are hidden and there is nothing to join. */
  active: boolean;
  hot: Net | null;
}

export default function BlueprintTraces({ active, hot }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [nets, setNets] = useState<NetGeometry[]>([]);
  const [settled, setSettled] = useState(false);

  useLayoutEffect(() => {
    // The sheet is the SVG's own parent: read at effect time, because a
    // parent's ref is not attached yet when a child's layout effect runs.
    const svg = svgRef.current;
    const sheet = svg?.parentElement;
    if (!active || svg == null || sheet == null) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Hidden by the stylesheet below 1100px: nothing to draw, nothing to measure.
        setNets(getComputedStyle(svg).display === 'none' ? [] : measure(sheet));
      });
    };
    update();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(sheet);
    // A card's picture or the "left out" group opening moves rows without
    // resizing the sheet's width; the columns are observed too.
    for (const el of sheet.querySelectorAll('[data-trace-left], [data-trace-right]')) ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, [active]);

  // Once the first draw has played, every later layout is drawn still.
  useLayoutEffect(() => {
    if (settled || nets.length === 0) return;
    const id = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [nets.length, settled]);

  return (
    <svg ref={svgRef} className={styles.traces} aria-hidden="true" focusable="false" data-settled={settled ? 'true' : undefined}>
      {active &&
        nets.map((g) => (
          <g
            key={g.net}
            className={styles.net}
            data-hot={hot === g.net ? 'true' : undefined}
            style={{ '--d': `${DELAY_S[g.net]}s` } as CSSProperties}
          >
            {g.paths.map((d, i) => (
              <path key={`t${i}`} d={d} pathLength={1} className={styles.trace} />
            ))}
            {g.paths.map((d, i) => (
              <path key={`p${i}`} d={d} pathLength={1} className={styles.pulse} />
            ))}
            {g.pads.map((p, i) => (
              <circle key={`c${i}`} cx={p.x} cy={p.y} r={4} className={styles.pad} />
            ))}
            <g className={styles.netLabel}>
              <rect x={g.label.x - g.label.w / 2} y={g.label.y - 9} width={g.label.w} height={18} rx={2} />
              <text x={g.label.x} y={g.label.y + 4} textAnchor="middle">
                {NET_LABEL[g.net]}
              </text>
            </g>
          </g>
        ))}
    </svg>
  );
}
