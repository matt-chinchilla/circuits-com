import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source witnesses for ConfirmAction (the money-action confirm). vitest runs
// with css:false, so these read the files rather than the rendered DOM.
const tsx = readFileSync(join(__dirname, 'ConfirmAction.tsx'), 'utf8');
const scss = readFileSync(join(__dirname, 'ConfirmAction.module.scss'), 'utf8');

describe('ConfirmAction', () => {
  it('renders in place — a portal to <body> would lose every --a-* admin token', () => {
    expect(tsx).not.toMatch(/createPortal/);
  });

  it('mints its Idempotency-Key per request scope and reuses it on retry', () => {
    expect(tsx).toMatch(/newIdempotencyKey\(\)/);
    expect(tsx).toMatch(/keys\.current\.get\(scope\)/);
  });

  it('holds its entrance still under reduced motion', () => {
    expect(scss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
  });
});
