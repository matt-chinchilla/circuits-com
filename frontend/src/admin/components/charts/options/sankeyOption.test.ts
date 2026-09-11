import { describe, expect, it } from 'vitest';
import {
  LAST_COLUMN_LABEL_ROOM,
  columnColor,
  sankeyOption,
  type SankeyLink,
  type SankeyNode,
} from './sankeyOption';

const nodes: SankeyNode[] = [
  { id: '0:Direct', label: 'Direct', column: 0 },
  { id: '0:Google', label: 'Google', column: 0 },
  { id: '1:Part page', label: 'Part page', column: 1 },
  { id: '2:Part page', label: 'Part page', column: 2 },
  { id: '2:Left the site', label: 'Left the site', column: 2 },
];
const links: SankeyLink[] = [
  { source: '0:Direct', target: '1:Part page', value: 30 },
  { source: '0:Google', target: '1:Part page', value: 10 },
  { source: '1:Part page', target: '2:Part page', value: 12 },
  { source: '1:Part page', target: '2:Left the site', value: 28 },
  // a link to a node the server never sent — must not reach ECharts
  { source: '1:Part page', target: '2:Ghost', value: 5 },
  { source: '1:Part page', target: '1:Part page', value: 1 },
];
const base = { nodes, links, unit: 'sessions', total: 40 };

function series(opt: ReturnType<typeof sankeyOption>) {
  return (opt as { series: Array<Record<string, unknown>> }).series[0];
}

describe('sankeyOption', () => {
  it('keys nodes by id so one label may sit in two columns', () => {
    const names = (series(sankeyOption(base)).data as Array<{ name: string }>).map((d) => d.name);
    expect(names).toEqual(['0:Direct', '0:Google', '1:Part page', '2:Part page', '2:Left the site']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('labels read the human label, never the id', () => {
    const formatter = (series(sankeyOption(base)).label as { formatter: (p: unknown) => string }).formatter;
    expect(formatter({ name: '2:Part page' })).toBe('Part page');
    expect(formatter({ name: 'unknown' })).toBe('unknown');
  });

  it('drops links to unknown nodes and self-links', () => {
    const out = series(sankeyOption(base)).links as Array<{ source: string; target: string }>;
    expect(out).toHaveLength(4);
    expect(out.some((l) => l.target === '2:Ghost')).toBe(false);
    expect(out.some((l) => l.source === l.target)).toBe(false);
  });

  it('keeps data order for layout (layoutIterations 0) and colors by column', () => {
    const s = series(sankeyOption(base));
    expect(s.layoutIterations).toBe(0);
    const data = s.data as Array<{ itemStyle: { color: string } }>;
    expect(data[0].itemStyle.color).toBe(columnColor(0));
    expect(data[2].itemStyle.color).toBe(columnColor(1));
    expect(data[4].itemStyle.color).toBe(columnColor(2));
    expect(columnColor(7)).toBe(columnColor(3));
  });

  it('switches orientation for a phone', () => {
    const s = series(sankeyOption({ ...base, orient: 'vertical' }));
    expect(s.orient).toBe('vertical');
    expect((s.label as { position: string }).position).toBe('top');
  });

  it('reserves room for the last column\'s labels only when horizontal', () => {
    expect(series(sankeyOption(base)).right).toBe(LAST_COLUMN_LABEL_ROOM);
    expect(series(sankeyOption({ ...base, orient: 'vertical' })).right).toBe(4);
    expect(series(sankeyOption(base)).labelLayout).toEqual({ hideOverlap: true });
  });

  it('pins every node to its column (ECharts would otherwise move sinks right)', () => {
    const data = series(sankeyOption(base)).data as Array<{ name: string; depth: number }>;
    expect(data.map((d) => [d.name, d.depth])).toEqual([
      ['0:Direct', 0],
      ['0:Google', 0],
      ['1:Part page', 1],
      ['2:Part page', 2],
      ['2:Left the site', 2],
    ]);
  });

  it('escapes tooltip HTML exactly once', () => {
    const amp = {
      ...base,
      nodes: [...nodes, { id: '0:Motor & Motion <ICs>', label: 'Motor & Motion <ICs>', column: 0 }],
      links: [...links, { source: '0:Motor & Motion <ICs>', target: '1:Part page', value: 2 }],
    };
    const formatter = (sankeyOption(amp) as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter;
    const html = formatter({ dataType: 'node', name: '0:Motor & Motion <ICs>', value: 2 });
    expect(html).toContain('Motor &amp; Motion &lt;ICs&gt;');
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toContain('<ICs>');
  });

  it('tooltip names both ends of a link with its share of the total', () => {
    const formatter = (sankeyOption(base) as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter;
    const html = formatter({ dataType: 'edge', data: { source: '0:Google', target: '1:Part page', value: 10 } });
    expect(html).toContain('Google');
    expect(html).toContain('Part page');
    expect(html).toContain('25.0%');
    expect(html).not.toContain('0:Google');
  });
});
