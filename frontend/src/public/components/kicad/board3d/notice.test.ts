import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Nothing else tests NOTICE.txt (context map §2). Every runtime dependency the
// viewer ships must be named in it, in the existing `=== name — url — licence ===` form.
const NOTICE = readFileSync(join(__dirname, '../../../../../public/vendor/kicanvas/NOTICE.txt'), 'utf8');

describe('the viewer notice file', () => {
  it.each([
    ['three.js', 'https://github.com/mrdoob/three.js', 'MIT'],
    ['earcut', 'https://github.com/mapbox/earcut', 'ISC'],
    ['KiCanvas', 'https://github.com/theacodes/kicanvas', 'MIT'],
  ])('names %s with its url and licence', (name, url, licence) => {
    const block = NOTICE.split('\n').find((l) => l.startsWith('=== ') && l.includes(name));
    expect(block, `${name} block`).toBeDefined();
    expect(block).toContain(url);
    expect(NOTICE.slice(NOTICE.indexOf(block!))).toContain(licence);
  });
});
