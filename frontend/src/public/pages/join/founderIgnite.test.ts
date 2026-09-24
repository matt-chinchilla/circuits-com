/**
 * The Founder's Discount perk ignite — a performance split that must not move
 * a pixel (2026-09-24, owner: the ignition "still causes lag").
 *
 * The design's one `joinIgnite` animated opacity + transform + color +
 * text-shadow on each perk's `.fdIgn`. color and text-shadow are INHERITED,
 * so every frame restyled everything inside `.fdIgn` — and the first perk
 * holds both Founder badges, whose shadow trees are ~175 elements (measured
 * 42 → 217 elements per style recalc while the prices' coal bed was being
 * drawn). The ignite is now one timeline across two elements: the group's
 * fade + rise stays on `.fdIgn`, the hot ink moves onto the perk's own text
 * span (`.perkTxt`) — the only element that shows it (the badges paint no
 * text and read no currentColor; the check glyph has its own `.fd .ck` color).
 *
 * vitest runs with css: false, so a CSS-module class proves nothing — these
 * read the SCSS source (the repo's witness pattern, see bomPage.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCSS = readFileSync(join(__dirname, 'JoinPage.module.scss'), 'utf8');
const TSX = readFileSync(join(__dirname, 'FounderDiscount.tsx'), 'utf8');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The body of the first `{ … }` block after `head`, braces balanced. */
function block(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`missing: ${head}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced: ${head}`);
}

/** `@keyframes name` → { '0%': { prop: value }, … } with whitespace squashed. */
function keyframes(name: string): Record<string, Record<string, string>> {
  const body = block(SCSS, `@keyframes ${name} `);
  const out: Record<string, Record<string, string>> = {};
  for (const m of body.matchAll(/([\d%,\s]+)\{([^}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = squash(d.slice(i + 1));
    }
    out[m[1].trim()] = decls;
  }
  return out;
}

// The design's single `joinIgnite`, stop for stop, as shipped before the split.
const DESIGN_IGNITE = {
  '0%': {
    opacity: '0',
    transform: 'translateY(5px)',
    color: 'var(--fd-hot)',
    'text-shadow': '0 0 6px var(--fd-soft), 0 0 14px var(--fd)',
  },
  '45%': {
    opacity: '1',
    color: 'var(--fd-hot)',
    'text-shadow': '0 0 5px var(--fd-soft), 0 0 10px color-mix(in srgb, var(--fd) 60%, transparent)',
  },
  '100%': { opacity: '1', transform: 'none', color: 'inherit', 'text-shadow': 'none' },
};

describe('the perk ignite is one timeline split across two elements', () => {
  it('the two halves add back up to the design, stop for stop', () => {
    const motion = keyframes('joinIgniteMotion');
    const ink = keyframes('joinIgniteInk');
    const merged: Record<string, Record<string, string>> = {};
    for (const kf of [motion, ink]) {
      for (const [stop, decls] of Object.entries(kf)) merged[stop] = { ...merged[stop], ...decls };
    }
    expect(merged).toEqual(DESIGN_IGNITE);
  });

  it('keeps the INHERITED ink off the group, and only the ink on the text', () => {
    for (const decls of Object.values(keyframes('joinIgniteMotion'))) {
      expect(Object.keys(decls).every(p => p === 'opacity' || p === 'transform')).toBe(true);
    }
    for (const decls of Object.values(keyframes('joinIgniteInk'))) {
      expect(Object.keys(decls).every(p => p === 'color' || p === 'text-shadow')).toBe(true);
    }
    // the single four-property keyframes is gone, so nothing re-attaches it
    expect(SCSS).not.toMatch(/@keyframes joinIgnite\s*\{/);
    expect(SCSS).not.toMatch(/animation:\s*joinIgnite\s/);
  });

  it('runs both halves on the same clock: 0.9s, ease, forwards, same stagger', () => {
    const group = squash(block(SCSS, '.fdIsOpen .checks .fdIgn {'));
    const text = squash(block(SCSS, '.fdIsOpen .checks .perkTxt {'));
    expect(group).toContain('animation: joinIgniteMotion 0.9s ease forwards;');
    expect(text).toContain('animation: joinIgniteInk 0.9s ease forwards;');
    const delay = 'animation-delay: calc(0.45s + var(--i, 0) * 0.3s);';
    expect(group).toContain(delay);
    expect(text).toContain(delay);
  });

  it('reduced motion stills both halves', () => {
    const reduced = SCSS.slice(SCSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(squash(block(reduced, '.fdIsOpen .checks .perkTxt {'))).toBe('animation: none;');
    expect(squash(reduced)).toContain('.fdIsOpen .checks .fdIgn, .stack[data-fd=\'on\'] .fdTag .fdIgn, .stack[data-fd=\'on\'] .fdNew .fdIgn { animation: none; opacity: 1; }');
  });

  it('the ink lands on the perk text span, and the badges are its sibling, not its child', () => {
    expect(TSX).toContain('<span className={styles.perkTxt}>{p}</span>');
    // `.perkTxt` closes before the badges open — the badge shadow trees stay
    // outside the element whose inherited properties animate
    const txt = TSX.indexOf('<span className={styles.perkTxt}>{p}</span>');
    const badges = TSX.indexOf('className={styles.fdBadges}');
    expect(txt).toBeGreaterThan(-1);
    expect(badges).toBeGreaterThan(txt);
  });
});
