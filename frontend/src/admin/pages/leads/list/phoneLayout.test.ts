// Source witnesses for the call list's phone layout — the fix for the mobile
// crash on scroll (owner report 2026-09-25).
//
// Measured root cause: the 50-row table sat inside a horizontal
// `overflow-x: auto` wrapper as tall as the table itself. A phone composites
// every overflowing scroller, so the whole table (1075x4169 CSS px, 3225x12507
// device px at 3x) became its own scrolled layer that the page's vertical
// scroll ran THROUGH. Removing that one scroller took composited layer area
// 457 MB -> 92 MB and touch hit-regions 4,422 -> 7 on a 390px phone. So at
// phone widths the rows stack into cards that fit the screen and nothing
// scrolls sideways; above that the table and its scroller are unchanged.
//
// vitest runs with css=false (CLAUDE.md), so the rules are asserted in the SCSS
// text rather than through `styles.*`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scss = readFileSync(join(__dirname, 'LeadsPage.module.scss'), 'utf8');
const tsx = readFileSync(join(__dirname, 'index.tsx'), 'utf8');

/** Body of the block opened at `from` (index of its `{`), braces included. */
function bodyAt(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error('unclosed block');
}

/** Every block opened by exactly `head {` (e.g. a media query), concatenated. */
function blocks(source: string, head: string): string {
  let out = '';
  for (let at = source.indexOf(`${head} {`); at >= 0; at = source.indexOf(`${head} {`, at + 1)) {
    out += bodyAt(source, source.indexOf('{', at));
  }
  if (!out) throw new Error(`no block for ${head}`);
  return out;
}

/** The declarations of `selector {` inside `source` (first match). */
function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return bodyAt(source, source.indexOf('{', at));
}

/** The stylesheet with every @media block cut out — the rules that apply at ALL widths. */
function withoutMedia(source: string): string {
  let out = source;
  for (let at = out.indexOf('@media'); at >= 0; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    out = out.slice(0, at) + out.slice(open + bodyAt(out, open).length);
  }
  return out;
}

const phone = blocks(scss, '@media (max-width: $bp-admin-mobile)');
const hover = blocks(scss, '@media (hover: hover)');
const everywhere = withoutMedia(scss);

describe('the call list on a phone', () => {
  it('has no horizontal scroll container — the table fits the screen instead', () => {
    expect(rule(phone, '.tableWrap')).toMatch(/overflow:\s*visible/);
    expect(rule(phone, '.table')).toMatch(/min-width:\s*0/);
  });

  it('keeps the scroller above phone width, where the full table still overflows', () => {
    expect(rule(everywhere, '.tableWrap')).toMatch(/overflow-x:\s*auto/);
    expect(rule(everywhere, '.table')).toMatch(/min-width:\s*940px/);
  });

  it('stacks each lead into a card instead of nine table columns', () => {
    expect(rule(phone, '.table tbody .row')).toMatch(/display:\s*flex/);
    expect(rule(phone, '.table tbody .row')).toMatch(/flex-wrap:\s*wrap/);
    // The header row becomes wrapping sort chips, never a sideways strip.
    expect(rule(phone, '.table thead tr')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('places every body cell by a class hook, not by column position', () => {
    for (const hook of [
      'cellContact',
      'cellCompany',
      'cellTier',
      'cellRing',
      'cellLocation',
      'cellOutcome',
      'cellAttempts',
      'cellWhen',
    ]) {
      expect(tsx).toContain(`styles.${hook}`);
      expect(phone).toContain(`.${hook}`);
    }
  });
});

describe('table semantics survive the card layout', () => {
  // Re-displaying table elements as block/flex drops their table role in some
  // browsers (Safari), so the roles are stated explicitly.
  it('states the table roles explicitly', () => {
    expect(tsx).toMatch(/<table[^>]*\brole="table"/);
    expect(tsx.match(/role="rowgroup"/g)?.length).toBe(2);
    expect(tsx).toMatch(/<tr\s[^>]*\brole="row"/);
    expect(tsx).toMatch(/role="cell"/);
    expect(tsx).toMatch(/role="columnheader"/);
    const header = readFileSync(join(__dirname, '../../manufacturers/ColumnHeader.tsx'), 'utf8');
    expect(header).toMatch(/<th\b[^>]*\brole="columnheader"/);
  });
});

describe('hover tints only where there is a real hover', () => {
  // A tap on a touch screen leaves :hover stuck on the tapped row and disc.
  it('gates the row tint and the disc halo to hover-capable pointers', () => {
    expect(hover).toMatch(/\.table tbody tr:hover\s*{[^}]*background:\s*var\(--a-hover\)/);
    expect(hover).toMatch(/\.discBtn:hover\s*{[^}]*background:\s*var\(--a-border-soft\)/);
    expect(everywhere).not.toMatch(/tr:hover/);
    expect(rule(everywhere, '.discBtn')).not.toMatch(/&:hover/);
  });
});
