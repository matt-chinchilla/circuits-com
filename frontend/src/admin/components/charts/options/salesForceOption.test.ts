// Geometry laws for the book-of-business graph (buildSalesForce):
//   - tier-fixed bubble AREA law (value never drives size),
//   - electron shells per tier (Platinum in, Silver out, empty shells collapse),
//   - even angular division per shell from 12 o'clock + chord constraint,
//   - the exported rest layout mirrors the option's node positions 1:1
//     (salesForcePhysics trusts it instead of re-deriving geometry).

import { describe, expect, it } from 'vitest';
import {
  buildSalesForce,
  type SalesForceCustomer,
  type SalesForceRestNode,
} from './salesForceOption';

interface NodeShape {
  name: string;
  kind: 'hub' | 'leaf' | 'summary';
  displayName: string;
  symbolSize: number;
  x: number;
  y: number;
}

function nodesOf(build: ReturnType<typeof buildSalesForce>): NodeShape[] {
  const series = (build.option as { series?: Array<{ data?: NodeShape[] }> }).series;
  return series?.[0]?.data ?? [];
}

function group(children: SalesForceCustomer[], name = 'Anthony') {
  return { name, color: '#0e7a49', total: 1000, children };
}

function leafDist(layout: SalesForceRestNode[], leaf: SalesForceRestNode): number {
  const hub = layout.find((l) => l.name === leaf.hubName);
  if (!hub) throw new Error(`missing hub for ${leaf.name}`);
  return Math.hypot(leaf.rest.x - hub.rest.x, leaf.rest.y - hub.rest.y);
}

describe('tier-fixed area law', () => {
  it('sizes bubbles by tier, not value: hub 54, Pt 38, Au 31, Ag 27', () => {
    const build = buildSalesForce({
      groups: [
        group([
          { label: 'P', value: 9, tier: 'Platinum' },
          { label: 'G', value: 9_000_000, tier: 'Gold' },
          { label: 'S', value: 14, tier: 'Silver' },
        ]),
      ],
    });
    const byName = new Map(nodesOf(build).map((n) => [n.displayName, n]));
    expect(byName.get('Anthony')?.symbolSize).toBe(54);
    expect(byName.get('P')?.symbolSize).toBe(38); // 54/√2
    expect(byName.get('G')?.symbolSize).toBe(31); // 54/√3
    expect(byName.get('S')?.symbolSize).toBe(27); // 54/2
  });

  it('normalizes free-form tier case and buckets unknown/null as Silver-sized', () => {
    const build = buildSalesForce({
      groups: [
        group([
          { label: 'lowercase-pt', value: 1, tier: 'platinum' },
          { label: 'mystery', value: 1, tier: 'Featured' },
          { label: 'nullish', value: 1, tier: null },
        ]),
      ],
    });
    const byName = new Map(nodesOf(build).map((n) => [n.displayName, n]));
    expect(byName.get('lowercase-pt')?.symbolSize).toBe(38);
    expect(byName.get('mystery')?.symbolSize).toBe(27);
    expect(byName.get('nullish')?.symbolSize).toBe(27);
  });
});

describe('electron shells', () => {
  it('rings order Platinum < Gold < Silver, with null tier on the Silver shell', () => {
    const build = buildSalesForce({
      groups: [
        group([
          { label: 'S', value: 1, tier: 'Silver' },
          { label: 'P', value: 1, tier: 'Platinum' },
          { label: 'G', value: 1, tier: 'Gold' },
          { label: 'N', value: 1, tier: null },
        ]),
      ],
    });
    const leaves = build.layout.filter((l) => l.kind === 'leaf');
    const dist = (label: string) => {
      const nodes = nodesOf(build);
      const node = nodes.find((n) => n.displayName === label);
      const leaf = leaves.find((l) => l.name === node?.name);
      if (!leaf) throw new Error(`no leaf ${label}`);
      return leafDist(build.layout, leaf);
    };
    // Innermost ring: hubR 27 + leafR 19 + 16 clearance.
    expect(dist('P')).toBeCloseTo(62, 5);
    expect(dist('G')).toBeGreaterThan(dist('P'));
    expect(dist('S')).toBeGreaterThan(dist('G'));
    // Null tier shares the Silver shell exactly.
    expect(dist('N')).toBeCloseTo(dist('S'), 5);
  });

  it('collapses empty shells: with no Platinum, Gold takes the innermost radius', () => {
    const build = buildSalesForce({
      groups: [group([{ label: 'G', value: 1, tier: 'Gold' }])],
    });
    const leaf = build.layout.find((l) => l.kind === 'leaf');
    if (!leaf) throw new Error('no leaf');
    // hubR 27 + goldR 15.5 + 16 clearance
    expect(leafDist(build.layout, leaf)).toBeCloseTo(58.5, 5);
  });

  it('divides a shell evenly from 12 o\'clock', () => {
    const build = buildSalesForce({
      groups: [
        group([
          { label: 'a', value: 1, tier: 'Silver' },
          { label: 'b', value: 1, tier: 'Silver' },
          { label: 'c', value: 1, tier: 'Silver' },
          { label: 'd', value: 1, tier: 'Silver' },
        ]),
      ],
    });
    const nodes = nodesOf(build);
    const hub = nodes.find((n) => n.kind === 'hub');
    const leaves = nodes.filter((n) => n.kind === 'leaf');
    if (!hub) throw new Error('no hub');
    const r = Math.hypot(leaves[0].x - hub.x, leaves[0].y - hub.y);
    const expected = [
      [hub.x, hub.y - r], // 12 o'clock (screen y grows down)
      [hub.x + r, hub.y],
      [hub.x, hub.y + r],
      [hub.x - r, hub.y],
    ];
    leaves.forEach((leaf, i) => {
      expect(leaf.x).toBeCloseTo(expected[i][0], 5);
      expect(leaf.y).toBeCloseTo(expected[i][1], 5);
    });
  });

  it('staggers shell starts 120° apart: 1-per-tier splays Silver top, Gold lower-right, Platinum lower-left', () => {
    // The owner's tripod spec — without the stagger, three single-occupant
    // shells all start at 12 o'clock and stack into a vertical column.
    const build = buildSalesForce({
      groups: [
        group([
          { label: 'p', value: 1, tier: 'Platinum' },
          { label: 'g', value: 1, tier: 'Gold' },
          { label: 's', value: 1, tier: 'Silver' },
        ]),
      ],
    });
    const nodes = nodesOf(build);
    const hub = nodes.find((n) => n.kind === 'hub');
    if (!hub) throw new Error('no hub');
    const angleOf = (label: string) => {
      const leaf = nodes.find((n) => n.displayName === label);
      if (!leaf) throw new Error(`no leaf ${label}`);
      return (Math.atan2(leaf.y - hub.y, leaf.x - hub.x) * 180) / Math.PI;
    };
    expect(angleOf('s')).toBeCloseTo(-90, 5); // outermost: 12 o'clock
    expect(angleOf('g')).toBeCloseTo(30, 5); // lower-right (screen y down)
    expect(angleOf('p')).toBeCloseTo(150, 5); // lower-left
  });

  it('grows a crowded shell to satisfy the chord constraint', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      label: `s${i}`,
      value: 1,
      tier: 'Silver',
    }));
    const build = buildSalesForce({ groups: [group(many)] });
    const leaf = build.layout.find((l) => l.kind === 'leaf');
    if (!leaf) throw new Error('no leaf');
    const minChordR = (27 + 12) / (2 * Math.sin(Math.PI / 12));
    expect(leafDist(build.layout, leaf)).toBeGreaterThanOrEqual(minChordR - 1e-6);
  });
});

describe('rest layout export', () => {
  it('mirrors option nodes 1:1 and wires leaf → hub ownership', () => {
    const build = buildSalesForce({
      groups: [
        group([{ label: 'P', value: 1, tier: 'Platinum' }], 'Anthony'),
        { ...group([{ label: 'X', value: 1, tier: 'Gold' }], 'Demo'), collapsed: true },
      ],
    });
    const nodes = nodesOf(build);
    expect(build.layout).toHaveLength(nodes.length);
    build.layout.forEach((l, i) => {
      expect(l.name).toBe(nodes[i].name);
      expect(l.kind).toBe(nodes[i].kind);
      expect(l.rest.x).toBeCloseTo(nodes[i].x, 9);
      expect(l.rest.y).toBeCloseTo(nodes[i].y, 9);
    });
    const hub = build.layout.find((l) => l.kind === 'hub');
    const leaf = build.layout.find((l) => l.kind === 'leaf');
    const summary = build.layout.find((l) => l.kind === 'summary');
    expect(hub?.hubName).toBeNull();
    expect(summary?.hubName).toBeNull();
    expect(leaf?.hubName).toBe(hub?.name);
  });

  it('returns an empty layout for the empty state', () => {
    expect(buildSalesForce({ groups: [] }).layout).toEqual([]);
  });
});
