/**
 * The tour's pictures ("Click a part once, find it everywhere") and every other
 * capture the guide shows: each file is the pixel size the page reserves for
 * it, the tour's are at least twice the largest box they are drawn in, the set
 * stays light, and the frames' shapes are witnessed in the SCSS source (vitest
 * runs with css: false, so a class name alone proves nothing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMAGES, type GuideImage } from './guideCopy';

const PUBLIC = join(__dirname, '../../../../../../public');
const bytesOf = (image: GuideImage) => readFileSync(join(PUBLIC, image.src));

/** A WebP's own pixel size, read from its first chunk (lossy, lossless or extended). */
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  throw new Error(`not a WebP chunk: ${chunk}`);
}

// The largest box (CSS px) each tour picture is drawn in, from
// PartTour.module.scss at its widest ($tour-max 1312px, panel column 300px):
// columns 1.6fr / 1fr of the 980px left over → the schematic and board frames
// 377 x 236 (16:10), the 3D frame 603 x 536 (measured at 1440), which its 3:2
// picture covers at 804 x 536 — held here with a little room for a caption
// that wraps. On a phone every frame takes the column's width, capped at 480
// (the schematic and board then draw at 480 x 300), and the panel up to 340.
const LARGEST_BOX = {
  tour3d: { width: 810, height: 540 },
  tourSchematic: { width: 480, height: 300 },
  tourBoard: { width: 480, height: 300 },
  tourPanel: { width: 340, height: 0 },
} as const;

const TOUR = Object.keys(LARGEST_BOX) as (keyof typeof LARGEST_BOX)[];

describe('the guide’s captures', () => {
  it('are each the pixel size the page reserves for them', () => {
    for (const [key, image] of Object.entries(IMAGES)) {
      expect(webpSize(bytesOf(image)), key).toEqual({ width: image.width, height: image.height });
    }
  });

  it('carry at least twice the pixels of the largest box the tour draws them in', () => {
    for (const key of TOUR) {
      const image = IMAGES[key];
      expect(image.width, key).toBeGreaterThanOrEqual(2 * LARGEST_BOX[key].width);
      expect(image.height, key).toBeGreaterThanOrEqual(2 * LARGEST_BOX[key].height);
    }
  });

  it('come in the shapes the frames are cut to: 3:2 for 3D, 16:10 for the schematic and board', () => {
    expect(IMAGES.tour3d.width / IMAGES.tour3d.height).toBeCloseTo(3 / 2, 2);
    expect(IMAGES.tourSchematic.width / IMAGES.tourSchematic.height).toBeCloseTo(16 / 10, 5);
    expect(IMAGES.tourBoard.width / IMAGES.tourBoard.height).toBeCloseTo(16 / 10, 5);
  });

  it('keep the tour under ~500 KB', () => {
    const total = TOUR.reduce((sum, key) => sum + bytesOf(IMAGES[key]).length, 0);
    expect(total).toBeLessThanOrEqual(500 * 1024);
  });

  it('never name the example project in their descriptions', () => {
    for (const [key, image] of Object.entries(IMAGES)) expect(image.alt, key).not.toMatch(/glasgow/i);
  });
});

describe('PartTour.module.scss', () => {
  const scss = readFileSync(join(__dirname, 'PartTour.module.scss'), 'utf8');

  it('re-asserts [hidden] on the tour, which sets its own display', () => {
    expect(scss).toMatch(/\.tour\[hidden\]\s*\{\s*display: none;/);
  });

  it('stops the grid growing at the width the captures were sized for', () => {
    expect(scss).toMatch(/\$tour-max:\s*1312px/);
    expect(scss).toMatch(/\$panel-col:\s*300px/);
    expect(scss).toMatch(/\.tourGrid\s*\{[^}]*grid-template-columns: minmax\(0, 1\.6fr\) minmax\(0, 1fr\) \$panel-col;[^}]*max-width: \$tour-max;/);
  });

  it('cuts the schematic and board frames at 16:10 and lets the views cover their frame out of flow', () => {
    expect(scss).toMatch(/\.frameFlat\s*\{[^}]*aspect-ratio: 16 \/ 10;/);
    expect(scss).toMatch(/\.view\s*\{[^}]*position: absolute;[^}]*object-fit: cover;/);
  });

  it('caps the phone column at 480px, the width the captures were sized for there', () => {
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.tourGrid\s*\{[^}]*max-width: \$tour-max-phone;/);
    expect(scss).toMatch(/\$tour-max-phone:\s*480px/);
  });

  it('brings the 3D view closer on the chip where its frame is small: tablet 1.3x, phone 1.4x', () => {
    const tablet = scss.slice(scss.indexOf('@media (max-width: $bp-tour)'), scss.indexOf('@include responsive($bp-mobile)'));
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(tablet).toMatch(/\.frame3d \{[\s\S]*?\.view \{\s*transform: scale\(1\.3\);\s*transform-origin: 57% 46%;/);
    expect(phone).toMatch(/\.frame3d \{[\s\S]*?\.view \{\s*transform: scale\(1\.4\);\s*transform-origin: 50% 46%;/);
    // Still 2x device pixels in the largest tablet box (642 x 360 at 1024, zoomed 1.3): 1680 / 1.3 >= 2 * 642.
    expect(IMAGES.tour3d.width / 1.3).toBeGreaterThanOrEqual(2 * 642);
  });

  it('on a full screen, puts the words beside the grid at $tour-max and centres the row, by the tour’s own width', () => {
    expect(scss).toMatch(/\.tour\s*\{[^}]*container-type: inline-size;/);
    expect(scss).toMatch(/\$tour-row-min: \$words-min \+ \$words-gap \+ \$tour-max;/);
    expect(scss).toMatch(/\$words-min:\s*280px/);
    const wide = scss.slice(scss.indexOf('@container (min-width: #{$tour-row-min})'), scss.indexOf('// Tablet:'));
    expect(wide.length).toBeGreaterThan(0);
    expect(wide).toMatch(
      /\.tourRow\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(\$words-min, \$words-max\) \$tour-max;[^}]*'head grid'\s*'foot grid';[^}]*justify-content: center;/,
    );
    expect(wide).toMatch(/\.tourGrid\s*\{\s*grid-area: grid;\s*align-self: start;/);
    expect(wide).toMatch(/\.legend\s*\{\s*display: block;/);
    expect(wide).toMatch(/\.caption \.enig\s*\{\s*@include swatch;/);
    expect(wide).toMatch(/\.tourGrid\[data-lit\] \.shot:not\(\[data-lit\]\)\s*\{\s*opacity: 0\.45;/);
  });

  it('draws no legend below that width, so every narrower layout is the one it was', () => {
    const before = scss.slice(0, scss.indexOf('@container'));
    expect(before).toMatch(/\.legend\s*\{\s*display: none;/);
    for (const rule of ['.tourRow', '.tourHead', '.tourFoot', '.legendTitle', '.legendList']) {
      expect(before, rule).not.toContain(`${rule} {`);
    }
  });

  it('gives each view the swatch colour that view draws with', () => {
    const swatch = (view: string) => scss.match(new RegExp(`&\\[data-view='${view}'\\] \\{\\s*--swatch: ([^;]+);`))?.[1];
    expect(swatch('three')).toBe('#4fc3f7'); // the 3D selection glow, board3dTheme HIGHLIGHT
    expect(swatch('sch')).toBe('#ffffc2'); // KiCanvas kicad theme: component_body
    expect(swatch('brd')).toBe('#c83434'); // KiCanvas kicad theme: copper.f
    expect(swatch('panel')).toBe('#{$enig}'); // the tour's ENIG pad
  });

  it('never crops the part panel: it keeps its own aspect', () => {
    const block = scss.slice(scss.indexOf('.framePanel {'), scss.indexOf('.caption {'));
    expect(block).toMatch(/height: auto;/);
    expect(block).not.toMatch(/object-fit|aspect-ratio/);
  });
});
