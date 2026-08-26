// @vitest-environment happy-dom
/**
 * The sign-in screen's three failure outcomes, and one of them is the whole
 * point: `POST /auth/login` answers a CORRECT password on an unconfirmed
 * address with `403 email_not_verified`, and this screen used to report that as
 * "Incorrect email or password." — the only screen that could reach that person,
 * telling them the one thing that was not true.
 *
 * Rendered rather than asserted through a helper: the defect was that nothing
 * on the CLIENT read the 403, so a test that only calls the classifier would
 * pass with the screen still lying. This drives the real form.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const login = vi.fn();
const resendVerification = vi.fn();

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('')],
}));
vi.mock('@admin/contexts/AuthContext', () => ({
  useAuth: () => ({ login }),
}));
vi.mock('@admin/services/adminApi', () => ({
  adminApi: { resendVerification: (email: string) => resendVerification(email) },
}));

const { default: SignIn } = await import('./SignIn');

function httpError(status: number, detail: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config as never, {}, {
    status,
    statusText: '',
    data: { detail },
    headers: {},
    config: config as never,
  });
}

let container: HTMLDivElement;
let root: Root;

function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Fill the form and submit it. The rejection `login` is primed with decides
 *  which outcome the screen has to render. */
async function attemptSignIn(email = '  Ada@Example.com  ', password = 'Sekret1!') {
  await act(async () => {
    root.render(createElement(SignIn, { go: vi.fn() }));
  });
  await act(async () => {
    type('email', email);
    type('password', password);
  });
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

/** The resend control, found by the class the design gives it — its LABEL
 *  changes as the cooldown runs, and matching on that would stop finding it
 *  exactly when the disabled state needs checking. */
function clickResend() {
  const button = container.querySelector<HTMLButtonElement>('button.resend');
  if (!button) throw new Error('no resend control on screen');
  return button;
}

beforeEach(() => {
  login.mockReset();
  resendVerification.mockReset();
  resendVerification.mockResolvedValue({ status: 'ok' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SignIn', () => {
  it('offers a resend instead of blaming the password on email_not_verified', async () => {
    login.mockRejectedValue(httpError(403, 'email_not_verified'));
    await attemptSignIn();
    const text = container.textContent ?? '';
    expect(text).toContain('Confirm your email');
    // The lie the reviewer found. It must be gone, not merely accompanied.
    expect(text).not.toContain('Incorrect email or password');
    // And the way out has to be on the screen, not only in the code.
    expect(clickResend()).toBeTruthy();
  });

  it('names the address so the user can see the typo they made', async () => {
    login.mockRejectedValue(httpError(403, 'email_not_verified'));
    await attemptSignIn();
    expect(container.textContent).toContain('Ada@Example.com');
  });

  it('sends a fresh link through the one endpoint that exists for it', async () => {
    login.mockRejectedValue(httpError(403, 'email_not_verified'));
    await attemptSignIn();
    await act(async () => {
      clickResend().dispatchEvent(new Event('click', { bubbles: true }));
    });
    // Trimmed and lower-cased: the address is the rate-limit key server-side
    // (signup_email_key lower-cases it), and an untrimmed one is a miss.
    expect(resendVerification).toHaveBeenCalledWith('ada@example.com');
    expect(container.textContent).toContain('New link sent');
  });

  it('holds the resend on a cooldown so the control cannot be hammered', async () => {
    login.mockRejectedValue(httpError(403, 'email_not_verified'));
    await attemptSignIn();
    await act(async () => {
      clickResend().dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Another link can be sent in 30s');
    expect(clickResend().disabled).toBe(true);
  });

  it('still gives the generic message for the generic 401', async () => {
    login.mockRejectedValue(httpError(401, 'Invalid credentials'));
    await attemptSignIn();
    expect(container.textContent).toContain('Incorrect email or password');
    expect(container.textContent).not.toContain('Confirm your email');
  });

  it('still says the server is unreachable when there is no response', async () => {
    login.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
    await attemptSignIn();
    expect(container.textContent).toContain('Couldn’t reach the server');
  });

  it('returns to the form when the user asks to', async () => {
    login.mockRejectedValue(httpError(403, 'email_not_verified'));
    await attemptSignIn();
    const back = [...container.querySelectorAll('button')].find((b) =>
      /back to sign in/i.test(b.textContent ?? ''),
    );
    await act(async () => {
      back?.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(container.querySelector('#password')).toBeTruthy();
  });
});
