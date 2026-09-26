// @vitest-environment happy-dom
// The designator chip's three-way branch (spec §6). It is the one place where
// the same cell renders three different elements, and the ORDER is the
// contract: a host that can focus the drawing itself wins over the row's
// viewer route, because a table showing the schematic beside it must not
// navigate away from it.
//
// No JSX (vitest only discovers *.test.ts here) — createElement + act, the
// harness useBomWorkbench.test.ts established.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import * as sass from 'sass';
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

// The header row's geometry (owner report 2026-09-26: "the DESCRIPTION and qty
// headers are overlapping"). vitest runs with `css: false`, so a class
// assertion proves nothing; this COMPILES the module from disk and reads the
// emitted CSS, because the rule that matters is Sass arithmetic: the width at
// which Description hides is the pinned columns' sum plus its floor, and a
// hand-typed threshold would drift the next time a column changes width.
describe('BomTable header geometry', () => {
  const src = join(__dirname, '..', '..', '..');
  const aliases: Record<string, string> = {
    '@shared/': join(src, 'shared') + '/',
    '@public/': join(src, 'public') + '/',
  };
  const css = sass.compile(join(__dirname, 'BomTable.module.scss'), {
    importers: [
      {
        // Rebuilt with the GLOBAL URL: this file runs under happy-dom, which
        // replaces it, and Sass rejects node:url's instance as "not a URL".
        findFileUrl(url: string) {
          const hit = Object.keys(aliases).find((prefix) => url.startsWith(prefix));
          return hit ? new URL(pathToFileURL(aliases[hit] + url.slice(hit.length)).href) : null;
        },
      },
    ],
    logger: sass.Logger.silent,
  }).css;

  const widths = new Map(
    Array.from(css.matchAll(/\.table \.(th\w+) \{\s*width: (\d+)px;\s*\}/g), (m) => [
      m[1],
      Number(m[2]),
    ]),
  );
  const pinnedSum = Array.from(widths.values()).reduce((a, b) => a + b, 0);

  it('pins a width on every header column but Description, keyed by class', () => {
    const tsx = readFileSync(join(__dirname, 'BomTable.tsx'), 'utf8');
    const thead = tsx.slice(tsx.indexOf('<thead>'), tsx.indexOf('</thead>'));
    // Modifiers and the a11y label are not columns; Description is the flexible one.
    const notColumns = new Set(['thRight', 'thHidden', 'thDesc']);
    const columns = new Set(
      Array.from(thead.matchAll(/styles\.(th[A-Z]\w*)/g), (m) => m[1]).filter(
        (name) => !notColumns.has(name),
      ),
    );

    expect(columns.size).toBe(10);
    expect(new Set(widths.keys())).toEqual(columns);
  });

  it('hides Description by the TABLE width, below the pinned sum plus a floor the header fits in', () => {
    const rule = css.match(
      /@media \(min-width: (\d+)px\) \{\s*@container \(width < (\d+)px\) \{\s*\.thDesc,\s*\.tdDesc \{\s*display: none;/,
    );
    expect(rule).not.toBeNull();
    const [, cardsBelow, room] = rule!.map(Number);

    // Scoped past the card breakpoint: a card still shows its description.
    expect(cardsBelow).toBe(769);
    // The floor is what is left when the table is exactly `room` wide. The
    // header alone is 123px (95px of "DESCRIPTION" + 28px padding, measured).
    expect(room - pinnedSum).toBeGreaterThanOrEqual(124);
    // And the wrap is the container the query measures.
    expect(css).toMatch(/\.tableWrap \{[^}]*container-type: inline-size;/);
  });

  it('clips a squeezed header at its own cell edge instead of painting over the next', () => {
    const th = css.match(/\n\.th \{([^}]*)\}/);
    expect(th).not.toBeNull();
    expect(th![1]).toMatch(/white-space: nowrap;[^]*overflow: hidden;/);
    // Not an ellipsis: that cuts at the content edge and would eat letters a
    // label has padding for in a slightly wider font.
    expect(th![1]).not.toMatch(/text-overflow/);
  });

  it('wraps a package warning inside the Description cell', () => {
    // The warning quotes a KiCad footprint name, one token with no spaces;
    // unwrapped it painted across QTY and out of the card.
    const warn = css.match(/\n\.packageWarn \{([^}]*)\}/);
    expect(warn).not.toBeNull();
    expect(warn![1]).toMatch(/max-width: 100%;/);
    expect(warn![1]).toMatch(/overflow-wrap: anywhere;/);
  });
});
