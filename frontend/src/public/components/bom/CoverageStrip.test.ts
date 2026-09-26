/**
 * CoverageStrip — the "N of M lines priced" bar above the BOM table.
 *
 * Source witnesses (vitest's `css` is off, so a class assertion proves
 * nothing): the strip is an in-flow block. It was `position: sticky` with a
 * navbar-sized offset, which on /viewer's BOM tab — a stage that scrolls by
 * itself — pushed the bar down over the table header at rest and pinned it
 * over the rows on scroll (owner report 2026-09-26). Putting sticky or a
 * backdrop veil back turns these red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCSS = readFileSync(join(__dirname, 'CoverageStrip.module.scss'), 'utf8');
const stripRule = (): string => {
  const at = SCSS.indexOf('.strip {');
  const uncommented = SCSS.slice(at).replace(/\/\/[^\n]*/g, '');
  return uncommented;
};

describe('CoverageStrip.module.scss', () => {
  it('the strip is in flow: no position: sticky anywhere in the file', () => {
    expect(SCSS.replace(/\/\/[^\n]*/g, '')).not.toMatch(/position:\s*sticky/);
  });

  it('no floating veil: no backdrop-filter, since nothing scrolls beneath a static block', () => {
    expect(SCSS.replace(/\/\/[^\n]*/g, '')).not.toMatch(/backdrop-filter/);
  });

  it('keeps the card material and its column layout', () => {
    const rule = stripRule();
    expect(rule).toContain('@include bom-card;');
    expect(rule).toContain('display: flex;');
    expect(rule).toContain('flex-direction: column;');
  });
});
