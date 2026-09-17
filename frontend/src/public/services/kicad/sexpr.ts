// KiCad s-expression tokenizer. Atoms stay strings; callers convert numbers.
// Iterative on purpose: a 10 MB board must not overflow the stack (spec §4.1).
import type { SExpr } from './types';

function isDelimiter(c: string): boolean {
  return c === '(' || c === ')' || c === '"' || c === ' ' || c === '\n' || c === '\t' || c === '\r';
}

function readQuoted(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let out = '';
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const e = text[i + 1];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === '"') out += '"';
      else if (e === '\\') out += '\\';
      else out += `\\${e ?? ''}`;
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    out += c;
    i++;
  }
  throw new Error(`unterminated string starting at ${start}`);
}

function skipQuoted(text: string, start: number): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new Error(`unterminated string starting at ${start}`);
}

/** Parse a whole document. Returns the list of top-level nodes (KiCad files have one). */
export function parse(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '(') {
      const node: SExpr[] = [];
      (stack[stack.length - 1] as SExpr[]).push(node);
      stack.push(node);
      i++;
    } else if (c === ')') {
      if (stack.length === 1) throw new Error(`unbalanced ) at ${i}`);
      stack.pop();
      i++;
    } else if (c === '"') {
      const { value, end } = readQuoted(text, i);
      (stack[stack.length - 1] as SExpr[]).push(value);
      i = end;
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
    } else {
      let j = i + 1;
      while (j < n && !isDelimiter(text[j])) j++;
      (stack[stack.length - 1] as SExpr[]).push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('unbalanced ( at end of input');
  return root;
}

export function head(node: SExpr): string | null {
  return Array.isArray(node) && typeof node[0] === 'string' ? node[0] : null;
}

/** First child list whose head is `name`. */
export function child(node: SExpr, name: string): SExpr[] | undefined {
  if (!Array.isArray(node)) return undefined;
  for (const item of node) if (Array.isArray(item) && item[0] === name) return item;
  return undefined;
}

/** Every child list whose head is `name`, in order. */
export function children(node: SExpr, name: string): SExpr[][] {
  const out: SExpr[][] = [];
  if (!Array.isArray(node)) return out;
  for (const item of node) if (Array.isArray(item) && item[0] === name) out.push(item);
  return out;
}

/** The string at position `index`, or null when absent, a list, or `node` itself isn't a list. */
export function atom(node: SExpr, index: number): string | null {
  if (!Array.isArray(node)) return null;
  const v = node[index];
  return typeof v === 'string' ? v : null;
}

export interface TopLevelBlock {
  head: string;
  start: number;
  end: number;
}

/** Yield the document node's direct children, without building a tree — the
 *  board reader parses only the blocks it needs. `start`/`end` are string
 *  offsets in UTF-16 code units (`start` inclusive, `end` exclusive), suitable
 *  only for `text.slice` — not byte offsets. */
export function* topLevelBlocks(text: string): Generator<TopLevelBlock> {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let blockStart = -1;
  let blockHead = '';
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i = skipQuoted(text, i);
    } else if (c === '(') {
      depth++;
      if (depth === 2) {
        blockStart = i;
        let j = i + 1;
        while (j < n && !isDelimiter(text[j])) j++;
        blockHead = text.slice(i + 1, j);
      }
      i++;
    } else if (c === ')') {
      if (depth === 0) throw new Error(`unbalanced ) at ${i}`);
      if (depth === 2 && blockStart >= 0) {
        yield { head: blockHead, start: blockStart, end: i + 1 };
        blockStart = -1;
      }
      depth--;
      i++;
    } else {
      i++;
    }
  }
  if (depth !== 0) throw new Error('unbalanced ( at end of input');
}
