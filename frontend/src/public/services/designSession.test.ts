// frontend/src/public/services/designSession.test.ts
import { describe, expect, it } from 'vitest';
import { ROOT_UUID, schematic, symbol } from '@public/services/kicad/fixtures';
import { buildProject } from '@public/services/kicad/project';
import {
  NO_BOM_LINES,
  clearDesignSession,
  getDesignSession,
  openDesign,
  publishDesign,
  readDesign,
  unpriceableReason,
} from './designSession';

const BOARD = '(kicad_pcb (version 20241229) (generator "pcbnew"))';

const f = (name: string, text: string) => new File([text], name);

describe('designSession', () => {
  it('holds one project with its BOM read once, and clears both', async () => {
    const project = await buildProject([new File([schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) })], 'main.kicad_sch')]);
    expect(getDesignSession()).toBeNull();
    const s = openDesign(project);
    expect(getDesignSession()).toBe(s);
    // The ONE stable project object: DesignCanvas keys its KiCanvas mount on this
    // reference, so a clone here would reload the viewer on every /viewer <-> /bom trip.
    expect(s.project).toBe(project);
    expect(s.parsed.lines).toHaveLength(1);
    expect(s.refs.get('R1')?.sheet).toBe('main.kicad_sch');
    clearDesignSession();
    expect(getDesignSession()).toBeNull();
  });
});

describe('unpriceableReason — the pricing tool\'s admission test', () => {
  it('passes a schematic with lines', async () => {
    const project = await buildProject([
      f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) })),
    ]);
    expect(unpriceableReason(readDesign(project))).toBeNull();
  });

  it('refuses a board-only project, in the reader\'s own words', async () => {
    // THE coupling `unpriceableReason` documents instead of re-testing
    // `project.root` itself: readSchematic answers root-less projects with an
    // error parse, and its sentence is the one shown. If that ever stops being
    // true this goes red rather than silently admitting an unpriceable design.
    const project = await buildProject([f('board.kicad_pcb', BOARD)]);
    expect(project.root).toBeNull();
    expect(unpriceableReason(readDesign(project))).toContain('No schematic in this project');
  });

  it('refuses a schematic that yielded no BOM line', async () => {
    // A sheet whose only symbol is a power flag: reads cleanly, prices nothing.
    const project = await buildProject([
      f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'power:GND', uuid: 'p', ref: '#PWR01', value: 'GND' }) })),
    ]);
    const design = readDesign(project);
    expect(design.parsed.error).toBeNull();
    expect(design.parsed.lines).toHaveLength(0);
    expect(unpriceableReason(design)).toBe(NO_BOM_LINES);
  });

  it('reading does not publish — a refused project must not evict the open one', async () => {
    const good = await buildProject([
      f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) })),
    ]);
    const open = openDesign(good);
    const boardOnly = await buildProject([f('board.kicad_pcb', BOARD)]);

    readDesign(boardOnly);

    expect(getDesignSession()).toBe(open);
    // …and publishing is the separate, deliberate step.
    const next = publishDesign(readDesign(good));
    expect(getDesignSession()).toBe(next);
    clearDesignSession();
  });
});
