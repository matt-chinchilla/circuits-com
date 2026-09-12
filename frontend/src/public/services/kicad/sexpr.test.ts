import { describe, expect, it } from 'vitest';
import { atom, child, children, head, parse, topLevelBlocks } from './sexpr';

describe('parse', () => {
  it('reads nested lists, bare atoms and quoted strings', () => {
    const doc = parse('(kicad_sch (version 20250114) (generator "eeschema") (title_block (title "Complex hierarchy: demo")))');
    expect(head(doc[0]!)).toBe('kicad_sch');
    expect(atom(child(doc[0]!, 'version')!, 1)).toBe('20250114');
    expect(atom(child(child(doc[0]!, 'title_block')!, 'title')!, 1)).toBe('Complex hierarchy: demo');
  });

  it('unescapes the five escapes KiCad writes and passes {…} through', () => {
    const doc = parse('(x "a\\"b" "line\\nbreak" "tab\\there" "back\\\\slash" "Device{slash}R")');
    expect(doc[0]).toEqual(['x', 'a"b', 'line\nbreak', 'tab\there', 'back\\slash', 'Device{slash}R']);
  });

  it('keeps unquoted uuids and negative numbers as atoms', () => {
    const doc = parse('(symbol (at -41.91 66.04 0) (uuid 00000000-0000-0000-0000-00004ad71b06))');
    expect(atom(child(doc[0]!, 'at')!, 1)).toBe('-41.91');
    expect(atom(child(doc[0]!, 'uuid')!, 1)).toBe('00000000-0000-0000-0000-00004ad71b06');
  });

  it('returns every child with a head, in order', () => {
    const doc = parse('(root (layer "F.Cu") (layer "B.Cu") (other 1))');
    expect(children(doc[0]!, 'layer').map((l) => atom(l, 1))).toEqual(['F.Cu', 'B.Cu']);
    expect(child(doc[0]!, 'missing')).toBeUndefined();
    expect(atom(doc[0]!, 99)).toBeNull();
  });

  it('is iterative: a 20 000-deep nest parses without a stack overflow', () => {
    const deep = '('.repeat(20_000) + 'x' + ')'.repeat(20_000);
    expect(() => parse(deep)).not.toThrow();
  });

  it('rejects unbalanced input with the offset', () => {
    expect(() => parse('(a (b)')).toThrow(/unbalanced/);
    expect(() => parse('(a))')).toThrow(/unbalanced/);
    expect(() => parse('(a "unterminated')).toThrow(/unterminated/);
  });
});

describe('topLevelBlocks', () => {
  const board = '(kicad_pcb (version 20241229)\n  (layers (0 "F.Cu" signal))\n  (via (at 1 2) (layers "F.Cu" "B.Cu"))\n  (via blind (at 3 4) (layers "F.Cu" "In1.Cu"))\n  (text "a ) in a string")\n)';

  it('yields depth-1 blocks with heads and byte offsets, ignoring parens inside strings', () => {
    const blocks = [...topLevelBlocks(board)];
    expect(blocks.map((b) => b.head)).toEqual(['version', 'layers', 'via', 'via', 'text']);
    const second = blocks[2]!;
    expect(board.slice(second.start, second.end)).toBe('(via (at 1 2) (layers "F.Cu" "B.Cu"))');
  });

  it('never allocates the tree: the slice of a block parses on its own', () => {
    const blind = [...topLevelBlocks(board)][3]!;
    expect(parse(board.slice(blind.start, blind.end))[0]).toEqual(['via', 'blind', ['at', '3', '4'], ['layers', 'F.Cu', 'In1.Cu']]);
  });
});
