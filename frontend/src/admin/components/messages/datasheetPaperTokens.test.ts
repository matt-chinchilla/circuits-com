// The datasheet sheet is a LIGHT-MODE ISLAND inside a themeable admin.
//
// `.datasheetCard` keeps its paper-white background in both themes, so every
// token the dark theme flips toward light ink has to be flipped BACK on the
// sheet — otherwise content painted on the paper inherits dark-mode ink and
// disappears. That already shipped once: the message subject rendered at
// 1.05:1 (near-white on white) and the ghost buttons were white-on-white with
// a white rim.
//
// This test pins the two lists together. Add a token to the dark block and the
// paper scope will fail here rather than in production, at night, on one page.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN_TOKENS = join(__dirname, '../AdminLayout.module.scss');
const PAPER = join(__dirname, './DatasheetFrame.module.scss');

/**
 * Tokens the dark theme overrides that CANNOT affect anything drawn on the
 * sheet, so the paper is not required to restore them:
 *   - page/nav/sidebar surfaces the sheet never paints
 *   - chart chrome (mirrored in chartTheme.ts; no chart is printed on paper)
 *   - the sheet's own cast shadow, which SHOULD follow the theme — the paper
 *     lies on a dark desk and needs a deeper shadow there, not a light one
 *   - filled-card hues, which carry white text on their own saturated fill in
 *     both themes and so are theme-correct wherever they appear
 */
const NOT_ON_PAPER = new Set([
  '--a-bg',
  '--a-nav-bg',
  '--a-side-bg',
  '--a-grid',
  '--a-axis',
  '--a-shadow-sm',
  '--a-shadow-md',
  '--a-teal',
  '--a-red',
]);

function tokenNames(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--a-[\w-]+)\s*:/gm)].map((m) => m[1]));
}

function darkBlock(src: string): string {
  const start = src.indexOf("html[data-admin-theme='dark']");
  expect(start, 'dark theme block not found in AdminLayout.module.scss').toBeGreaterThan(-1);
  // The block runs to the closing brace of the nested selector; the token
  // declarations are all that matter, so read to the next top-level rule.
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }');
  return rest.slice(0, end === -1 ? rest.length : end);
}

function paperScope(src: string): string {
  const start = src.indexOf('.datasheetCard {');
  expect(start, '.datasheetCard rule not found').toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}');
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('datasheet paper token island', () => {
  const admin = readFileSync(ADMIN_TOKENS, 'utf8');
  const paper = readFileSync(PAPER, 'utf8');

  it('restores every dark-flipped token that can reach the sheet', () => {
    const dark = tokenNames(darkBlock(admin));
    const restored = tokenNames(paperScope(paper));
    const missing = [...dark].filter((t) => !NOT_ON_PAPER.has(t) && !restored.has(t));
    expect(
      missing,
      `these tokens flip in dark mode but are not restored on the paper — content ` +
        `using them will render dark-mode ink on a white sheet: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the sheet itself paper-white in both themes', () => {
    // The motif, not an accident: crop marks and the PCB grid print on it in
    // ink. If this ever becomes themed, the token island above is dead weight.
    expect(paperScope(paper)).toMatch(/background:\s*#ffffff/);
  });

  it('gives the sheet its own dark-desk shadow', () => {
    // The one thing that SHOULD follow the theme — white paper on a near-black
    // desk needs the depth, or it reads as pasted-on glare.
    expect(paper).toMatch(/html\[data-admin-theme='dark'\]\)?\s*\.datasheetCard/);
  });
});
