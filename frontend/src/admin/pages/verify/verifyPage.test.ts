// @vitest-environment happy-dom
/**
 * The verify page's ONE job: spend the emailed token with exactly one POST,
 * then redirect. Both halves are easy to break invisibly, so they are pinned
 * here rather than left to a manual click-through.
 *
 * StrictMode is deliberately part of the harness — main.tsx wraps the whole app
 * in it, so the double-invoked effect IS the shipping condition in dev, and a
 * per-run cancel flag that survives review would strand the page on "One
 * moment" forever while looking perfectly reasonable in the diff.
 *
 * No JSX: this file is a `*.test.ts` (excluded from `tsc -b`/eslint per
 * CLAUDE.md), so elements are built with createElement.
 */
import { StrictMode, createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const verifyEmail = vi.fn();
let search = '';

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(search)],
}));
vi.mock('@admin/services/adminApi', () => ({
  adminApi: { verifyEmail: (token: string) => verifyEmail(token) },
}));
// The branded two-panel shell drags in the logo, the CSS-3D board and a SCSS
// module; none of that is under test and all of it is slow.
vi.mock('@admin/pages/login/components/AuthShell', () => ({
  default: ({ children }: { children: unknown }) =>
    createElement('div', null, children as never),
}));

const { default: VerifyPage } = await import('./index');

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(VerifyPage)));
  });
}

beforeEach(() => {
  navigate.mockReset();
  verifyEmail.mockReset();
  verifyEmail.mockResolvedValue({ status: 'ok' });
  search = '?token=tok-123';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('VerifyPage', () => {
  it('spends the token with exactly ONE post under StrictMode', async () => {
    await render();
    // Two would report "already used" on a link the human only clicked once.
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith('tok-123');
  });

  it('redirects to the sign-in welcome banner on success', async () => {
    await render();
    expect(navigate).toHaveBeenCalledWith('/admin/login?welcome=1', { replace: true });
    expect(container.textContent).not.toContain('did not work');
  });

  it('shows the expired copy when the token is refused', async () => {
    verifyEmail.mockRejectedValue(new Error('400'));
    await render();
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('That link has expired or has already been used.');
  });

  it('never posts when the link carries no token', async () => {
    search = '';
    await render();
    expect(verifyEmail).not.toHaveBeenCalled();
    expect(container.textContent).toContain('That link is missing its code.');
  });
});
