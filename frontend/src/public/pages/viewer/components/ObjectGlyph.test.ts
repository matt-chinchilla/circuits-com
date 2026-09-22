// @vitest-environment happy-dom
// One glyph per object class, drawn in currentColor and hidden from the
// accessibility tree — the row's label is the name.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { CLASSES_2D, CLASSES_3D, type ObjectClass } from '../boardView';
import ObjectGlyph from './ObjectGlyph';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ObjectGlyph', () => {
  it('draws every class the two Objects lists offer, and nothing that is not a class', async () => {
    const kinds = [...new Set<ObjectClass>([...CLASSES_2D.map((c) => c.kind), ...CLASSES_3D.map((c) => c.kind)])];
    expect(kinds.length).toBe(10);
    for (const kind of kinds) {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      await act(async () => root.render(createElement(ObjectGlyph, { kind })));
      const svg = el.querySelector('svg')!;
      expect(svg, kind).not.toBeNull();
      expect(svg.getAttribute('data-glyph')).toBe(kind);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      // Something is drawn: at least one shape inside.
      expect(svg.children.length, kind).toBeGreaterThan(0);
      await act(async () => root.unmount());
      el.remove();
    }
  });
});
