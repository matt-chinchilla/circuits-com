// @vitest-environment happy-dom
//
// The catch-all route is what nginx's SPA fallback lands on for every unknown
// URL, always with a 200. Its head is the only thing that tells a crawler the
// URL is not a page — this pins that the rendered page actually puts
// `noindex` into the document head.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import NotFoundPage from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NotFoundPage head', () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
    document.head.innerHTML = '';
  });

  it('renders robots noindex and no canonical', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          HelmetProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/no-such-page'] }, createElement(NotFoundPage)),
        ),
      );
    });

    const robots = document.querySelector('meta[name="robots"]');
    expect(robots?.getAttribute('content')).toBe('noindex');
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.title).toBe('Page Not Found | Circuit Center');

    await act(async () => root.unmount());
  });
});
