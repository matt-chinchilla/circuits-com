import { describe, expect, it } from 'vitest';
import { fixtureFiles, fixtureText, hasFixture } from './fixtures';

describe('fixture corpus', () => {
  it('carries Glasgow revC3 with its licence and source', () => {
    const names = fixtureFiles('glasgow-revC3').map((f) => f.name).sort();
    expect(names).toEqual(['glasgow.kicad_pcb', 'glasgow.kicad_pro', 'glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch']);
    expect(fixtureText('glasgow-revC3/LICENSE')).toMatch(/Permission to use, copy, modify/);
    expect(fixtureText('glasgow-revC3/SOURCE')).toMatch(/49e29452a3372fcc5aea790c080c0be554d15800/);
  });
  it('carries the keyboard panel and the KiCad 5 header', () => {
    expect(fixtureFiles('bad-thing-panel').map((f) => f.name).sort()).toEqual(['panel.kicad_pcb', 'panel.kicad_pro', 'panel.kicad_sch']);
    expect(fixtureText('kicad5-header.sch').startsWith('EESchema Schematic File Version 2')).toBe(true);
  });
  it.skipIf(!hasFixture('kicad-demos'))('carries the KiCad demos once the licence exists', () => {
    expect(fixtureText('kicad-demos/SOURCE')).toMatch(/CC BY-SA 4\.0/);
  });
});
