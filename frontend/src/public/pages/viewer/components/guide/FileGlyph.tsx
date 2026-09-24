// The folder listing's file glyphs, drawn inline (one 16×18 page per kind),
// tinted by what the file feeds: grey project, violet sheets, green board.
import type { Net } from './guideCopy';

const STROKE: Record<Net | 'out', string> = { pro: '#6b7076', sch: '#7a5bd0', pcb: '#2e9a0c', out: '#8a929b' };

export function FolderGlyph({ muted = false }: { muted?: boolean }) {
  return (
    <svg viewBox="0 0 16 18" aria-hidden="true" focusable="false">
      <path d="M1 4.5h5l1.5 2H15v9H1z" fill={muted ? '#eceef1' : '#e8c77a'} stroke={muted ? '#8a929b' : '#a88d2e'} />
    </svg>
  );
}

export function FileGlyph({ kind }: { kind: Net | 'out' }) {
  const s = STROKE[kind];
  return (
    <svg viewBox="0 0 16 18" aria-hidden="true" focusable="false">
      <path d="M2 1h8l4 4v12H2z" fill="#fff" stroke={s} />
      {kind === 'pro' && <circle cx="8" cy="11" r="2.6" fill="none" stroke={s} strokeWidth="1.4" />}
      {kind === 'sch' && <path d="M4.5 11h2l1-2 1.5 4 1-2h2" fill="none" stroke={s} strokeWidth="1.3" />}
      {kind === 'pcb' && <rect x="5" y="8" width="6" height="6" fill="none" stroke={s} strokeWidth="1.3" />}
    </svg>
  );
}
