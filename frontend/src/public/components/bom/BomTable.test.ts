// @vitest-environment happy-dom
// The designator chip's three-way branch (spec §6). It is the one place where
// the same cell renders three different elements, and the ORDER is the
// contract: a host that can focus the drawing itself wins over the row's
// viewer route, because a table showing the schematic beside it must not
// navigate away from it.
//
// No JSX (vitest only discovers *.test.ts here) — createElement + act, the
// harness useBomWorkbench.test.ts established.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableRow } from '@public/services/bom/types';
import BomTable from './BomTable';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (over: Partial<TableRow> = {}): TableRow => ({
  index: 0,
  mpn: null,
  value: '1k',
  footprint: null,
  description: null,
  manufacturer: null,
  distributorPn: null,
  qty: 1,
  refs: ['R12'],
  dnp: false,
  server: null,
  state: 'matched',
  viewerHref: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(row: TableRow, onRefClick?: (ref: string) => void) {
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(BomTable, {
          rows: [row],
          buildQty: 1,
          onBuildQtyChange: () => {},
          onPickSimilar: null,
          includeDnp: false,
          onIncludeDnpChange: () => {},
          onRefClick,
        }),
      ),
    );
  });
}

/** The chip element for a designator: the only leaf carrying exactly that
 *  text. Class names are not selectable here — vitest returns a proxy for CSS
 *  modules — so the assertion is on the TAG, which is the thing that changed. */
function chip(ref: string): Element {
  const found = Array.from(container.querySelectorAll('a, button, span')).filter(
    (el) => el.childElementCount === 0 && el.textContent === ref,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

describe('BomTable designator chips', () => {
  it('stays plain text when the row knows no viewer and the host cannot focus', () => {
    render(line());
    expect(chip('R12').tagName).toBe('SPAN');
  });

  it('links to the viewer with the reference as an encoded hash', () => {
    render(line({ refs: ['R12', 'U1/2'], viewerHref: '/viewer' }));

    const r12 = chip('R12');
    expect(r12.tagName).toBe('A');
    expect(r12.getAttribute('href')).toBe('/viewer#R12');
    expect(chip('U1/2').getAttribute('href')).toBe('/viewer#U1%2F2');
  });

  it('becomes an in-page button that outranks the row route, and never navigates', () => {
    const onRefClick = vi.fn();
    // TWO designators, and the SECOND one is clicked: on a single-ref row the
    // callback argument is indistinguishable from `row.refs[0]`, so a handler
    // that ignored its own chip would pass. On a real board that mutant
    // focuses the wrong component, silently.
    render(line({ refs: ['R12', 'C7'], viewerHref: '/viewer' }), onRefClick);

    const el = chip('C7');
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('title')).toBe('Find C7 on the schematic');
    expect(el.getAttribute('aria-label')).toBeNull();
    expect(container.querySelector('a[href^="/viewer"]')).toBeNull();

    act(() => {
      (el as HTMLButtonElement).click();
    });
    expect(onRefClick).toHaveBeenCalledExactlyOnceWith('C7');
  });
});
