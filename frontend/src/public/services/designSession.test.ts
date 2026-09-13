// frontend/src/public/services/designSession.test.ts
import { describe, expect, it } from 'vitest';
import { ROOT_UUID, schematic, symbol } from '@public/services/kicad/fixtures';
import { buildProject } from '@public/services/kicad/project';
import { clearDesignSession, getDesignSession, openDesign } from './designSession';

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
