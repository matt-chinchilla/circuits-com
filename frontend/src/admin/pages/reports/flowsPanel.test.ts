import { describe, expect, it } from 'vitest';
import type { FlowPayload } from '@admin/types/admin';
import { MIN_CLICKS_TO_DRAW, drawableFlow } from './FlowsPanel';

const parts: FlowPayload = {
  kind: 'parts',
  period_days: 30,
  segment: 'humans',
  columns: ['Category', 'Subcategory', 'Part'],
  nodes: [
    { id: '0:Semis', label: 'Semis', column: 0 },
    { id: '1:MCUs', label: 'MCUs', column: 1 },
    { id: '2:SKU1', label: 'SKU1', column: 2, hint: 'Maker' },
  ],
  links: [
    { source: '0:Semis', target: '1:MCUs', value: 10 },
    { source: '1:MCUs', target: '2:SKU1', value: 10 },
  ],
  unit: 'views',
  total: 10,
  clicks_total: 4,
  distributor_nodes: [{ id: '3:Digi-Key', label: 'Digi-Key', column: 3 }],
  distributor_links: [{ source: '2:SKU1', target: '3:Digi-Key', value: 4 }],
};

describe('drawableFlow', () => {
  it('leaves the distributor column out below the click floor', () => {
    const d = drawableFlow(parts);
    expect(d.withDistributors).toBe(false);
    expect(d.columns).toEqual(['Category', 'Subcategory', 'Part']);
    expect(d.nodes).toHaveLength(3);
    expect(d.links).toHaveLength(2);
  });

  it('draws it once there are enough clicks to read', () => {
    const d = drawableFlow({ ...parts, clicks_total: MIN_CLICKS_TO_DRAW });
    expect(d.withDistributors).toBe(true);
    expect(d.columns).toEqual(['Category', 'Subcategory', 'Part', 'Distributor']);
    expect(d.nodes.map((n) => n.id)).toContain('3:Digi-Key');
    expect(d.links).toHaveLength(3);
  });

  it('never adds a distributor column to the traffic flow', () => {
    const d = drawableFlow({ ...parts, kind: 'traffic', clicks_total: 999 });
    expect(d.withDistributors).toBe(false);
  });
});
