// Error copy in dark mode. --a-danger (#c0392b) is a FILL token as well as a
// text colour — badges and buttons put white text on it — so it cannot lighten
// for dark mode; on --a-bg it measured 3.42:1, under AA for 12–13px copy.
// --a-danger-text is the lifted TEXT token. This pins its dark value to ≥4.5:1
// against every dark surface the error copy sits on, and pins the Add-lead
// form's error copy to it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(join(__dirname, 'AdminLayout.module.scss'), 'utf8');
const leadNew = readFileSync(join(__dirname, '../pages/leads/new/LeadNew.module.scss'), 'utf8');

function darkBlock(src: string): string {
  const start = src.indexOf("html[data-admin-theme='dark']");
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf('\n  }'));
}

function hexToken(block: string, name: string): string {
  const m = block.match(new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm'));
  expect(m, `${name} is not a plain hex in the dark block`).not.toBeNull();
  return m![1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('dark-mode error text', () => {
  const dark = darkBlock(admin);
  const text = hexToken(dark, '--a-danger-text');

  it('clears AA on the page, the card and the lightest dark glass', () => {
    // #252f42 ≈ the dark --a-glass top stop (rgba(30,39,56,.9)) over a card,
    // the lightest surface a field message sits on.
    for (const surface of [hexToken(dark, '--a-bg'), hexToken(dark, '--a-card'), '#252f42']) {
      expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is what the Add-lead form paints its error copy with', () => {
    expect(leadNew).not.toMatch(/color:\s*var\(--a-danger\)/);
    expect(leadNew.match(/color:\s*var\(--a-danger-text\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
