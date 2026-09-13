// @vitest-environment happy-dom
/**
 * Which reader a drop goes to, and what the intake says when one refuses.
 *
 * The BOM tool now has TWO readers behind one drop zone — the spreadsheet
 * parser and `buildProject` — and the routing is by extension. The cases worth
 * pinning are the ones a hand test is least likely to try: a real project
 * FOLDER (KiCad files beside gerbers and backups the accept filter rejects),
 * and a KiCad refusal, whose message is the only thing telling somebody their
 * KiCad 5 project needs re-saving.
 *
 * `react-dropzone` is stubbed down to the one thing this is about: the `onDrop`
 * it would call. Nothing here tests the library.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KicadReadError } from '@public/services/kicad/types';
import { ROOT_UUID, schematic, symbol } from '@public/services/kicad/fixtures';

type AnyProps = Record<string, never> & Record<string, unknown>;
type Drop = (accepted: File[], rejections: { file: File }[]) => void;

const dropzone = { onDrop: null as Drop | null };
const buildProject = vi.fn(async (_files: File[]) => project);

const SCH = schematic({
  uuid: ROOT_UUID,
  body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }),
});

/** Real enough for the REAL schematic reader: `readDesign` and
 *  `unpriceableReason` are deliberately NOT mocked, so the intake's admission
 *  test is exercised rather than described. */
const project = {
  name: 'glasgow',
  files: new Map([['main.kicad_sch', SCH]]),
  pro: null,
  root: 'main.kicad_sch',
  sheets: [{ path: 'main.kicad_sch', uuid: ROOT_UUID, text: SCH }],
  board: null,
  warnings: [],
  missingSheets: [],
  formatVersions: {},
};

/** What a lone `.kicad_pcb` builds to — a fine thing to VIEW and nothing the
 *  BOM tool can price. */
const boardOnly = { ...project, files: new Map(), root: null, sheets: [], board: 'glasgow.kicad_pcb' };

/** Every session the intake published, in order. */
const published: { project: unknown }[] = [];

vi.mock('react-dropzone', () => ({
  useDropzone: (opts: { onDrop: Drop }) => {
    dropzone.onDrop = opts.onDrop;
    return {
      getRootProps: (props: AnyProps) => props ?? {},
      getInputProps: () => ({}),
      isDragActive: false,
      open: vi.fn(),
    };
  },
}));
// PARTIAL: `readSchematic` imports `basename` from this same module, so a
// whole-module replacement makes the real reader throw the moment it walks a
// sheet — which is how a green "the project reader was called" test can sit
// beside a drop that actually failed.
vi.mock('@public/services/kicad/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@public/services/kicad/project')>();
  return { ...actual, buildProject: (f: File[]) => buildProject(f) };
});
vi.mock('@public/services/designSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@public/services/designSession')>();
  return {
    ...actual,
    publishDesign: (session: { project: unknown }) => {
      published.push(session);
      return session;
    },
  };
});

const { default: BomIntake } = await import('./components/BomIntake');

const parsed: { result: unknown; name: string; text: string }[] = [];

function file(name: string, body = ''): File {
  return new File([body], name);
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      createElement(BomIntake, {
        onParsed: (result: unknown, name: string, text: string) => {
          parsed.push({ result, name, text });
        },
      }),
    );
  });
}

async function drop(accepted: File[], rejections: File[] = []) {
  await act(async () => {
    dropzone.onDrop?.(accepted, rejections.map((f) => ({ file: f })));
  });
}

function errorText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  parsed.length = 0;
  dropzone.onDrop = null;
  buildProject.mockClear();
  buildProject.mockImplementation(async () => project);
  published.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('routing a drop to the right reader', () => {
  it('sends KiCad files to the project reader and opens the design', async () => {
    await render();
    await drop([file('glasgow.kicad_pro', '{}'), file('main.kicad_sch', '(kicad_sch)')]);
    expect(buildProject).toHaveBeenCalledTimes(1);
    expect((buildProject.mock.calls[0]?.[0] ?? []).map((f) => f.name)).toEqual([
      'glasgow.kicad_pro',
      'main.kicad_sch',
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]?.project).toBe(project);
    // The session's own parse, named by the project, with NO source text: a
    // schematic BOM has no columns to re-materialize (there is no mapper).
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('glasgow');
    expect(parsed[0]?.text).toBe('');
    expect((parsed[0]?.result as { lines: unknown[] }).lines).toHaveLength(1);
  });

  it('sends a zip to the project reader too', async () => {
    await render();
    await drop([file('glasgow-revC3.zip')]);
    expect(buildProject).toHaveBeenCalledTimes(1);
  });

  it('leaves a spreadsheet BOM on the parser', async () => {
    await render();
    await drop([file('bom.csv', 'MPN,Qty\nLM317T,4\n')]);
    expect(buildProject).not.toHaveBeenCalled();
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('bom.csv');
    expect(parsed[0]?.text).toContain('LM317T');
  });

  it('reads a project FOLDER whose other files the filter rejected', async () => {
    await render();
    // What dropping a project directory really looks like: the schematic gets
    // through, the gerbers and the autosave do not. Complaining about the
    // housekeeping would fail a drop that is perfectly readable.
    await drop([file('main.kicad_sch', '(kicad_sch)')], [file('top.gbr'), file('_autosave.kicad_sch')]);
    expect(buildProject).toHaveBeenCalledTimes(1);
    expect(errorText()).toBeNull();
  });

  it('speaks up only when NOTHING got through', async () => {
    await render();
    await drop([], [file('notes.pdf')]);
    expect(buildProject).not.toHaveBeenCalled();
    expect(errorText()).toContain('.pdf');
  });

  it('prefers the project reader when both kinds land together', async () => {
    await render();
    await drop([file('bom.csv', 'MPN\n'), file('main.kicad_sch', '(kicad_sch)')]);
    expect(buildProject).toHaveBeenCalledTimes(1);
    expect((buildProject.mock.calls[0]?.[0] ?? []).map((f) => f.name)).toEqual(['main.kicad_sch']);
  });
});

describe('when the project reader refuses', () => {
  it('repeats its reason verbatim — that is the only thing that says what to do', async () => {
    await render();
    buildProject.mockImplementation(async () => {
      throw new KicadReadError('This is a KiCad 5 project. Open it in KiCad 6 or newer and save it.', 'kicad5');
    });
    await drop([file('board.kicad_sch')]);
    expect(errorText()).toContain('KiCad 5 project');
    expect(parsed).toHaveLength(0);
  });

  it('falls back to its own copy for a throw that is not a read refusal', async () => {
    await render();
    buildProject.mockImplementation(async () => {
      throw new TypeError('boom');
    });
    await drop([file('board.kicad_sch')]);
    expect(errorText()).toContain('could not be read');
    expect(errorText()).not.toContain('boom');
  });

  it('lets the reader try again — the busy state is released on failure', async () => {
    await render();
    buildProject.mockImplementation(async () => {
      throw new KicadReadError('nope', 'unreadable');
    });
    await drop([file('board.kicad_sch')]);
    const chooser = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Choose a file');
    expect(chooser?.disabled).toBe(false);
  });
});

describe('a project the BOM tool cannot price', () => {
  it('names the reason and opens NO session', async () => {
    await render();
    buildProject.mockImplementation(async () => boardOnly);
    // The format line invites a bare .kicad_pcb, so this is a drop the page
    // asks for. It reads fine — there is simply no schematic to take a BOM
    // from — and publishing it would put "Continue with glasgow from the
    // viewer" in front of somebody who has never opened the viewer.
    await drop([file('glasgow.kicad_pcb')]);
    expect(errorText()).toContain('No schematic in this project');
    expect(published).toHaveLength(0);
    expect(parsed).toHaveLength(0);
  });

  it('leaves a project already open in /viewer alone', async () => {
    await render();
    buildProject.mockImplementation(async () => boardOnly);
    await drop([file('glasgow.kicad_pcb')]);
    // Nothing was published, so nothing was evicted: read-then-publish is what
    // makes the refusal free of side effects.
    expect(published).toHaveLength(0);
  });
});

describe('more than one BOM at a time', () => {
  it('asks for one rather than reading the first in silence', async () => {
    await render();
    await drop([file('rev-a.csv', 'MPN\nX\n'), file('rev-b.csv', 'MPN\nY\n')]);
    expect(parsed).toHaveLength(0);
    expect(errorText()).toContain('one BOM at a time');
  });

  it('does not mistake a multi-file KiCad project for that', async () => {
    await render();
    await drop([file('glasgow.kicad_pro', '{}'), file('main.kicad_sch', '(kicad_sch)')]);
    expect(errorText()).toBeNull();
    expect(buildProject).toHaveBeenCalledTimes(1);
  });
});
