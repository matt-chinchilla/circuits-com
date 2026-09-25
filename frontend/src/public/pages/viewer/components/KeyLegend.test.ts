// @vitest-environment happy-dom
/**
 * The key legend lists what the maps say, never what someone typed: every key
 * of every map appears exactly once as a <kbd>, and a view the project does
 * not offer is not listed (nor are the 3D keys without a 3D tab).
 */
import { act, createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_ACTION_LABEL, BOARD_KEYS, SPIN_AXES, SPIN_KEYS, SPIN_LABEL, VIEW_MODE_KEYS } from '@public/components/kicad/board3d/shortcuts';
import { VIEW_MODES } from '@public/components/kicad/board3d/viewMode';
import { VIEW_KEY, VIEW_LABEL, VIEW_ORDER, type ViewId } from '../viewLabels';
import KeyLegend, { LEGEND_KEY } from './KeyLegend';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const asViews = (ids: readonly ViewId[]) => ids.map((id) => ({ id, label: VIEW_LABEL[id] }));

async function render(ids: readonly ViewId[], open = true, onToggle = vi.fn()) {
  await act(async () => {
    root.render(createElement(KeyLegend, { views: asViews(ids), open, onToggle }));
  });
  return onToggle;
}

/** The caps in the card — the summary's `?` hint is decoration, not a row. */
const caps = () => [...container.querySelectorAll('dl kbd, p kbd')].map((k) => k.textContent);
/** The action written beside a cap. */
const actionFor = (key: string) =>
  [...container.querySelectorAll('dl > div')].find((row) => row.querySelector('dt')?.textContent === key)?.querySelector('dd')?.textContent;

describe('the key legend', () => {
  it('lists every key of every map exactly once, as a <kbd>, with its name', async () => {
    await render(VIEW_ORDER);
    const shown = caps();
    const expected: [string, string][] = [
      ...VIEW_ORDER.map((id): [string, string] => [VIEW_KEY[id], VIEW_LABEL[id]]),
      ...(Object.keys(BOARD_KEYS) as (keyof typeof BOARD_KEYS)[]).map((a): [string, string] => [BOARD_KEYS[a], BOARD_ACTION_LABEL[a]]),
      ...VIEW_MODES.map((m): [string, string] => [VIEW_MODE_KEYS[m.id], m.label]),
      ...SPIN_AXES.map((a): [string, string] => [SPIN_KEYS[a], SPIN_LABEL[a]]),
    ];
    for (const [key, name] of expected) {
      expect(shown.filter((k) => k === key.toUpperCase())).toHaveLength(1);
      expect(actionFor(key.toUpperCase())).toBe(name);
    }
    // The page's older keys, each once.
    for (const key of ['/', 'Esc', LEGEND_KEY]) expect(shown.filter((k) => k === key)).toHaveLength(1);
    // Shift is a cap of its own, and its note names the spin keys from the map.
    expect(shown.filter((k) => k === 'Shift')).toHaveLength(1);
    expect(container.textContent).toContain('With X, Y or Z: the other way. The same press again stops the spin.');
  });

  it('lists only the views the project offers, and no 3D keys without a 3D tab', async () => {
    await render(['schematic', 'bom']);
    const shown = caps();
    expect(shown).toContain(VIEW_KEY.schematic.toUpperCase());
    expect(shown).toContain(VIEW_KEY.bom.toUpperCase());
    for (const id of ['board', 'stackup', 'board3d'] as const) expect(shown).not.toContain(VIEW_KEY[id].toUpperCase());
    for (const key of [...Object.values(BOARD_KEYS), ...Object.values(VIEW_MODE_KEYS), ...Object.values(SPIN_KEYS)]) expect(shown).not.toContain(key.toUpperCase());
    expect(shown).not.toContain('Shift');
    expect(container.textContent).not.toMatch(/On the 3D tab/);
  });

  it('says the rule once, at the foot', async () => {
    await render(VIEW_ORDER);
    expect(container.textContent).toContain('Plain presses only \u2014 not while typing in a field.');
  });

  it('is controlled: the summary asks the page, and the answer the page gives is what shows', async () => {
    const onToggle = await render(VIEW_ORDER, false);
    const details = container.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      container.querySelector('summary')!.dispatchEvent(click);
    });
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(click.defaultPrevented).toBe(true);
    await render(VIEW_ORDER, true, onToggle);
    expect(details.hasAttribute('open')).toBe(true);
  });

  it('carries no hover title', async () => {
    await render(VIEW_ORDER);
    expect(container.querySelector('[title]')).toBeNull();
  });

  // vitest runs css=false, so the rule is witnessed in the source. On a phone
  // the Keys button wrapped the top bar to three rows: there, the summary goes
  // and the legend leaves the flow (no width, no flex gap); `?` still opens it.
  it('leaves the phone top bar its two rows', () => {
    const scss = readFileSync(join(__dirname, 'KeyLegend.module.scss'), 'utf8');
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.legend \{[^{}]*position:\s*absolute/);
    expect(phone).toMatch(/\.summary \{[^{}]*display:\s*none/);
  });
});
