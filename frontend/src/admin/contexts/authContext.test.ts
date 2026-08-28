// @vitest-environment happy-dom
/**
 * The wire from the server's 403 to the awaiting-approval screen.
 *
 * ProtectedRoute's tests take `accountActivated` as given; this file is where it
 * comes FROM. Without it, a mutation that hardcoded the probe to `true` would
 * leave every ProtectedRoute test green while the shipped console went straight
 * back to rendering in full and 403-ing one panel at a time.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMe = vi.fn();
const getAccountMe = vi.fn();

vi.mock('@admin/services/adminApi', () => ({
  adminApi: {
    getMe: () => getMe(),
    getAccountMe: () => getAccountMe(),
    login: vi.fn(),
    changePassword: vi.fn(),
  },
}));
vi.mock('@admin/services/passwordGate', () => ({
  passwordGate: {
    subscribe: () => () => {},
    isRequired: () => false,
    set: vi.fn(),
  },
}));

const { AuthProvider, useAuth } = await import('./AuthContext');

/** Prints the one value under test, so the assertion reads the real context,
 *  and exposes logout so the teardown branch can be driven. */
function Probe() {
  const { accountActivated, loading, logout } = useAuth();
  return createElement(
    'button',
    { onClick: logout },
    `${loading ? 'loading' : String(accountActivated)}`,
  );
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => {
    root.render(createElement(AuthProvider, null, createElement(Probe)));
  });
  // The probe is a second request chained after /auth/me resolves; one more
  // flushed tick lets it settle.
  await act(async () => {});
  return container.textContent;
}

function forbidden(detail: string) {
  return { response: { status: 403, data: { detail } } };
}

beforeEach(() => {
  getMe.mockReset();
  getAccountMe.mockReset();
  localStorage.setItem('admin_token', 'tok');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});

describe('AuthContext activation probe', () => {
  it('reports a customer NOT activated on the backend 403', async () => {
    getMe.mockResolvedValue({ id: 'u1', username: 'James', role: 'user' });
    getAccountMe.mockRejectedValue(forbidden('account_not_activated'));
    expect(await mount()).toBe('false');
  });

  it('reports a customer activated when the probe answers', async () => {
    getMe.mockResolvedValue({ id: 'u1', username: 'James', role: 'user' });
    getAccountMe.mockResolvedValue({ id: 'u1', full_name: 'James', email: 'a@b.c', activated: true });
    expect(await mount()).toBe('true');
  });

  it('does not probe for staff, and leaves the answer unasked', async () => {
    getMe.mockResolvedValue({ id: 'u9', username: 'matthew', role: 'owner' });
    expect(await mount()).toBe('null');
    // activated_at is NULL on every staff row — asking would park all of them.
    expect(getAccountMe).not.toHaveBeenCalled();
  });

  it('fails OPEN when the probe cannot reach the server', async () => {
    getMe.mockResolvedValue({ id: 'u1', username: 'James', role: 'user' });
    getAccountMe.mockRejectedValue(new Error('Network Error'));
    expect(await mount()).toBe('true');
  });

  it('drops the verdict on sign-out', async () => {
    // Two people share a machine. The second must not inherit the first's
    // answer — either direction is wrong: an activated verdict would open a
    // console the server refuses, and a stale `false` would park somebody who
    // is fine.
    getMe.mockResolvedValue({ id: 'u1', username: 'James', role: 'user' });
    getAccountMe.mockRejectedValue(forbidden('account_not_activated'));
    expect(await mount()).toBe('false');
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(container.textContent).toBe('null');
  });
});
