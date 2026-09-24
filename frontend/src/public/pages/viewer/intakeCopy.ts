// What the viewer's intake says, kept apart from the component so the /viewer
// guide can print the SAME sentences (and a test can import them) without
// pulling in the drop zone.
import { MODERN_KICAD_EXTENSIONS } from '@public/services/kicad/zip';

export const EXAMPLE_URL = '/samples/glasgow-revC3.zip';
export const EXAMPLE_CREDIT = 'Example: Glasgow Interface Explorer revC3, 0BSD';

/** ".kicad_pro, .kicad_sch and .kicad_pcb" — the reader's own list, in prose. */
export function listInProse(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export const KICAD_FILES_PROSE = listInProse(MODERN_KICAD_EXTENSIONS);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** The line a drop gets when NOTHING in it is a file type the zone accepts. */
export function rejectionCopy(name: string): string {
  const ext = extensionOf(name);
  const what = ext === '' ? 'That file has no extension' : `That's a ${ext}`;
  return `${what} — drop the ${KICAD_FILES_PROSE} files, or a zip of the project folder.`;
}

export const UNREADABLE_COPY = 'Those files could not be read. Drop the project folder as a zip and try again.';
export const EXAMPLE_FAILED_COPY = 'The example project could not be loaded right now. Drop a project of your own instead.';
