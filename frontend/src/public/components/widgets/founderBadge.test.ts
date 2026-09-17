// @vitest-environment happy-dom
/**
 * FounderBadge — the founding-distributor pin beside a sponsor's company name.
 *
 * Two kinds of witness. The DOM tests render the widget itself (createRoot +
 * act, no testing-library — the shape bomPage.test.ts uses) and pin the
 * contract the boards rely on: an accessible image, a per-instance gradient id
 * set (three boards mount on one page), the size prop. The source-level tests
 * read the three board files — the badge is a shared unit precisely because it
 * has three consumers, and nothing else proves a site kept its `founder &&`
 * guard. A CSS-module class assertion proves nothing here (vitest's `css` is
 * off, the import is an echo proxy), so the module's rule is read from disk.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import FounderBadge, { FOUNDER_BADGE_LABEL } from './FounderBadge';

const COMPONENTS = join(__dirname, '..', '..', 'pages', 'category', 'components');
const read = (file: string) => readFileSync(join(COMPONENTS, file), 'utf8');

describe('FounderBadge (DOM)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('is an accessible image with the founding-distributor label and a hover title', () => {
    act(() => root.render(createElement(FounderBadge, { size: 22 })));
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe(FOUNDER_BADGE_LABEL);
    expect(svg?.querySelector('title')?.textContent).toBe(FOUNDER_BADGE_LABEL);
    expect(svg?.getAttribute('width')).toBe('22');
    expect(svg?.getAttribute('height')).toBe('22');
    expect(host.querySelector('a')).toBeNull();
  });

  it('defaults to the Gold size', () => {
    act(() => root.render(createElement(FounderBadge)));
    expect(host.querySelector('svg')?.getAttribute('width')).toBe('18');
  });

  it('gives every instance its own gradient + filter ids, all of them url()-safe', () => {
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(FounderBadge, { size: 22 }),
          createElement(FounderBadge, { size: 18 }),
          createElement(FounderBadge, { size: 15 }),
        ),
      ),
    );
    const ids = Array.from(host.querySelectorAll('defs [id]')).map((n) => n.id);
    expect(ids).toHaveLength(15); // 5 defs × 3 badges
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^fb-[a-z]+-[A-Za-z0-9_-]+$/);
    // every paint reference resolves to an id in the SAME badge
    for (const svg of host.querySelectorAll('svg')) {
      const own = new Set(Array.from(svg.querySelectorAll('defs [id]')).map((n) => n.id));
      const refs = Array.from(svg.querySelectorAll('[fill^="url("], [filter^="url("]')).map(
        (n) => (n.getAttribute('fill') ?? n.getAttribute('filter'))!.slice(5, -1),
      );
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(own.has(ref)).toBe(true);
    }
  });

  it('is the enamel-pin material: hairline wire, no gloss ellipse, a struck F', () => {
    act(() => root.render(createElement(FounderBadge)));
    const svg = host.querySelector('svg')!;
    const radii = Array.from(svg.querySelectorAll('circle')).map((c) => Number(c.getAttribute('r')));
    // outer separation hairline, the wire, then the enamel disc — the visible
    // gold ring is the wire radius minus the enamel radius: a hairline.
    expect(radii[0]).toBeGreaterThan(radii[1]);
    const wireWidth = Number((radii[1] - radii[2]).toFixed(3)); // 11.4 - 10.2 in IEEE
    expect(wireWidth).toBeGreaterThanOrEqual(0.8);
    expect(wireWidth).toBeLessThanOrEqual(1.2);
    expect(svg.querySelector('ellipse')).toBeNull(); // rev 2's gloss is gone
    expect(svg.querySelectorAll('path')).toHaveLength(2); // impression + face
    expect(svg.querySelector('path')?.getAttribute('transform')).toBe('translate(0 0.7)');
  });
});

describe('the three boards render the badge beside the company name', () => {
  it('Platinum: beside the coname link/span, keyed on the board data, 22px', () => {
    const src = read('CategorySponsor.tsx');
    expect(src).toContain("import FounderBadge from '@public/components/widgets/FounderBadge'");
    expect(src).toContain('founder: sponsor.founder === true');
    expect(src).toContain('{s.founder && <FounderBadge size={22} />}');
    // beside, not inside: the badge follows the closing of the conditional link
    const row = src.slice(src.indexOf('className="csbA-conamerow"'));
    expect(row.indexOf('<FounderBadge')).toBeGreaterThan(row.indexOf(')}'));
  });

  it('Gold: inside the h3 beside the name text, 18px', () => {
    const src = read('SponsorBlock.tsx');
    expect(src).toContain('{sponsor.founder === true && <FounderBadge size={18} />}');
    expect(src).toContain('<span className={styles.nameText}>{sponsor.supplier_name}</span>');
    const scss = readFileSync(join(COMPONENTS, 'SponsorBlock.module.scss'), 'utf8');
    expect(scss).toMatch(/\.nameText\s*\{\s*@include truncate;/);
  });

  it('Silver: beside the chip name, 15px, carried on the chip data', () => {
    const src = read('SilverPartners.tsx');
    expect(src).toContain('founder: s.founder === true');
    expect(src).toContain('{s.founder && <FounderBadge size={15} />}');
  });

  it('the payload types name the flag as optional-nullable on all three shapes', () => {
    const types = readFileSync(join(__dirname, '..', '..', 'types', 'sponsor.ts'), 'utf8');
    expect(types.match(/founder\?: boolean \| null;/g)).toHaveLength(3);
  });

  it('the module rule exists (vitest css is off — read it from disk)', () => {
    const scss = readFileSync(join(__dirname, 'FounderBadge.module.scss'), 'utf8');
    expect(scss).toMatch(/\.badge\s*\{[^}]*flex:\s*0 0 auto/);
    expect(scss).toMatch(/vertical-align:\s*-0\.18em/);
  });
});
