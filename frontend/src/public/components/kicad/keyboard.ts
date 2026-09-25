/**
 * The one guard for single-key shortcuts on the viewer page and the 3D board.
 *
 * A shortcut fires only on a PLAIN press: no modifier (ctrl+R stays the
 * browser's reload, ctrl+1 its tab switch, shift+t is not t), not already
 * handled by something nearer the target, and not typed into a field, where
 * the letter is text. CapsLock is fine: callers compare `e.key.toLowerCase()`.
 */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

type KeyLike = Pick<KeyboardEvent, 'defaultPrevented' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'>;

/** `shift: true` admits Shift for a key whose shifted press means something
 *  of its own (the 3D spins: shift+x turns the other way). Every other rule stands. */
export function isPlainKey(e: KeyLike, { shift = false }: { shift?: boolean } = {}): boolean {
  return !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && (shift || !e.shiftKey) && !typingIn(e.target);
}
