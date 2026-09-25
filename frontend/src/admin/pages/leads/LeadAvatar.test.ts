// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import LeadAvatar from './LeadAvatar';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(props: { photoUrl: string | null; contactName: string | null }): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(LeadAvatar, props));
  });
  return host.querySelector('[data-lead-avatar]') as HTMLElement;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

/** Owner, 2026-09-25: a company-only row must not read as a person by the company's name. */
describe('LeadAvatar', () => {
  it('shows the picture when there is one', async () => {
    const el = await render({ photoUrl: PNG, contactName: 'Ian Locke' });
    expect(el.dataset.leadAvatar).toBe('photo');
    expect(el.querySelector('img')?.getAttribute('src')).toBe(PNG);
  });

  it("shows a person's initials when there is no picture", async () => {
    const el = await render({ photoUrl: null, contactName: 'Ian Locke' });
    expect(el.dataset.leadAvatar).toBe('initials');
    expect(el.textContent).toBe('IL');
  });

  it('shows a company mark, never letters, when nobody is on file', async () => {
    const el = await render({ photoUrl: null, contactName: null });
    expect(el.dataset.leadAvatar).toBe('company');
    expect(el.textContent).toBe('');
    expect(el.querySelector('.ph-buildings')).not.toBeNull();
  });

  it('never puts an unsafe stored value into the image', async () => {
    const el = await render({ photoUrl: 'javascript:alert(1)', contactName: null });
    expect(el.querySelector('img')).toBeNull();
    expect(el.dataset.leadAvatar).toBe('company');
  });
});
