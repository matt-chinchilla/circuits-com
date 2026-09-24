// Source-level witnesses for the Add-lead page. vitest runs with css=false, so
// `styles.layout` is a proxy that echoes its key whether or not the rule exists
// (CLAUDE.md) — the rules the layout depends on are asserted in the SCSS text.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scss = readFileSync(join(__dirname, 'LeadNew.module.scss'), 'utf8');
const tsx = readFileSync(join(__dirname, 'index.tsx'), 'utf8');

/** The body of the FIRST top-level-or-nested block opened by `selector {`. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed block for ${selector}`);
}

describe('Add lead layout', () => {
  it('puts the call on the left and what can wait on the right, one column below desktop', () => {
    const layout = block(scss, '.layout');
    expect(layout).toMatch(/display:\s*grid/);
    expect(layout).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 340px/);
    expect(layout).toMatch(/@media \(max-width: \$bp-desktop\)\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it('stacks the two-up field rows on a phone', () => {
    const pair = block(scss, '.pair');
    expect(pair).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
    expect(pair).toMatch(/@media \(max-width: 560px\)\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it('keeps the save bar reachable from anywhere in a long form', () => {
    const actions = block(scss, '.actions');
    expect(actions).toMatch(/position:\s*sticky/);
    expect(actions).toMatch(/bottom:\s*12px/);
  });

  it('draws the match rail as a trace and a via, and holds still for reduced motion', () => {
    const rail = block(scss, '.rail');
    expect(rail).toMatch(/&::before\s*{[^}]*border-left:/);
    expect(rail).toMatch(/&::after\s*{[^}]*border-radius:\s*50%/);
    expect(rail).toMatch(/&\[data-refused\]\s*{\s*--rail-ink:\s*var\(--a-warn\)/);
    expect(rail).toMatch(/prefers-reduced-motion: reduce\)\s*{\s*animation:\s*none/);
  });

  it('gives every field a visible focus ring', () => {
    const fields = block(scss, '.input,\n.textarea');
    expect(fields).toMatch(/&:focus\s*{\s*@include a-well-focus/);
  });
});

describe('Add lead form markup', () => {
  it('validates in JS: noValidate, and every input is a plain text field', () => {
    expect(tsx).toMatch(/noValidate/);
    const inputs = tsx.match(/<input\b[^>]*>/gs) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input).toMatch(/type="text"/);
  });

  it('ties errors to their fields for screen readers', () => {
    expect(tsx).toMatch(/aria-invalid=\{error \? true : undefined\}/);
    expect(tsx).toMatch(/aria-describedby=\{describedBy\}/);
    expect(tsx).toMatch(/role="alert"/);
  });

  it('picks the size with the console dropdown, not a native select', () => {
    expect(tsx).toMatch(/from '@admin\/components\/ListSelect\/ListSelect'/);
    expect(tsx).not.toMatch(/<select\b/);
  });
});
