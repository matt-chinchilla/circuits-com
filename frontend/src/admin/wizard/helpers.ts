import type { WizardStoreSnapshot } from './types';

// Resolve a target element from a selector string OR a function that
// returns one. Functions are useful when the selector depends on runtime
// state (e.g. "the row whose data-msg-status is 'new'").
export function findEl(sel: string | (() => Element | null) | undefined): Element | null {
  if (!sel) return null;
  if (typeof sel === 'function') {
    try {
      return sel();
    } catch {
      return null;
    }
  }
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}

export function findField(name: string): Element | null {
  return name ? document.querySelector(`[data-field="${name}"]`) : null;
}

export function findFieldInput(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const wrapper = findField(name);
  if (!wrapper) return null;
  return wrapper.querySelector('input, textarea, select') as
    | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
}

export function getFieldValue(name: string): string {
  return findFieldInput(name)?.value ?? '';
}

// React 18+ swallows direct el.value = v assignments on controlled inputs.
// Walk up to the prototype's setter and call it through .call(el, value),
// then dispatch input + change so React's synthetic event system picks it up.
// Same pattern the wizard's "Use it" autofill chips need.
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function autofillField(name: string, value: string): void {
  const inp = findFieldInput(name);
  if (!inp) return;
  inp.focus({ preventScroll: false });
  setNativeValue(inp, value);
}

const EMPTY_STORE: WizardStoreSnapshot = {
  suppliers: [],
  parts: [],
  sponsors: [],
  messages: [],
  imports: [],
};

export function getStore(): WizardStoreSnapshot {
  try {
    return window.__adminGetStore?.() ?? EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

// React Router uses non-hash paths under /admin, but the wizard's flow
// definitions express routes WITHOUT the /admin prefix (e.g. "suppliers/new"
// instead of "/admin/suppliers/new"). This matches the original design's
// expression style. Strip the /admin prefix so flow tests stay tight.
export function getRoute(): string {
  const path = window.location.pathname;
  const m = path.match(/^\/admin\/?(.*)$/);
  return m ? m[1] : '';
}

export function navTo(path: string): void {
  if (!path) return;
  // Always prefix /admin/ — the flow DSL drops it for readability.
  const target = path.startsWith('/admin') ? path : `/admin/${path.replace(/^\//, '')}`;
  window.__adminNavigate?.(target);
}
