// @vitest-environment happy-dom
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ListSelect, { type ListOption } from './ListSelect';

// happy-dom does not implement these; the component only needs them to exist.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: ListOption<number>[] = Array.from({ length: 16 }, (_, p) => ({
  value: p,
  label: p === 0 ? '$8,500 | Founder’s Deal' : `$${(8500 - p * 100).toLocaleString('en-US')} | ${p}%`,
  keys: [String(p)],
}));

let host: HTMLDivElement;
let root: Root;
let picked: number[];

function Harness() {
  const [value, setValue] = useState(0);
  return createElement(ListSelect<number>, {
    id: 'price',
    ariaLabel: 'Monthly price',
    value,
    options: OPTIONS,
    onChange: (v: number) => {
      picked.push(v);
      setValue(v);
    },
  });
}

const trigger = () => document.getElementById('price') as HTMLButtonElement;
const listbox = () => document.querySelector('[role="listbox"]') as HTMLElement | null;
const key = (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

beforeEach(async () => {
  picked = [];
  document.body.innerHTML = '<div data-admin-root></div>';
  host = document.createElement('div');
  document.querySelector('[data-admin-root]')!.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('ListSelect', () => {
  it('opens a listbox portaled into the admin root, not <body>', async () => {
    await act(async () => trigger().click());
    const list = listbox();
    expect(list).not.toBeNull();
    expect(list!.closest('[data-admin-root]')).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(16);
    expect(document.querySelector('[aria-selected="true"]')!.textContent).toContain('Founder');
  });

  it('jumps to a percent by typing it, and Enter picks it', async () => {
    await act(async () => trigger().click());
    const menu = listbox()!.parentElement!;
    await key(menu, '1');
    await key(menu, '2');
    await key(menu, 'Enter');
    expect(picked).toEqual([12]);
    expect(listbox()).toBeNull();
    expect(trigger().textContent).toContain('12%');
  });

  it('arrows move the active row and Escape closes without picking', async () => {
    await act(async () => trigger().click());
    const menu = listbox()!.parentElement!;
    await key(menu, 'ArrowDown');
    await key(menu, 'ArrowDown');
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe('price-opt-2');
    let escapedToDialog = false;
    document.addEventListener('keydown', () => (escapedToDialog = true), { once: true });
    await key(menu, 'Escape');
    expect(listbox()).toBeNull();
    expect(picked).toEqual([]);
    expect(escapedToDialog).toBe(false); // a surrounding dialog must stay open
  });

  it('closes on a pointer-down outside', async () => {
    await act(async () => trigger().click());
    expect(listbox()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(listbox()).toBeNull();
  });
});
