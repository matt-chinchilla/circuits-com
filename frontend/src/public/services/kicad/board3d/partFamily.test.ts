import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { PART_FAMILIES, partFamily } from './partFamily';
import { readBoardModel } from './readBoardModel';

describe('partFamily — Glasgow revC3, every footprint', () => {
  const model = readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.05);
  const byRef = (re: RegExp) => model.footprints.filter((fp) => re.test(fp.ref));
  it('reads the board', () => {
    expect(model.footprints).toHaveLength(272);
  });
  it('every J is a connector — the pin headers, the USB-C, the IDC headers, the sockets', () => {
    const js = byRef(/^J\d/);
    expect(js.length).toBeGreaterThanOrEqual(8);
    for (const fp of js) expect(partFamily(fp.lib, fp.ref), `${fp.ref} ${fp.lib}`).toBe('connector');
    expect(js.some((fp) => fp.lib.includes('PinHeader_2x22'))).toBe(true);
    expect(js.some((fp) => fp.lib.includes('USB_C'))).toBe(true);
  });
  it('every U is an IC — SOT, SSOP, QFN, BGA, DFN, custom-library or not', () => {
    const us = byRef(/^U\d/);
    expect(us.length).toBeGreaterThanOrEqual(20);
    for (const fp of us) expect(partFamily(fp.lib, fp.ref), `${fp.ref} ${fp.lib}`).toBe('ic');
    expect(us.some((fp) => fp.lib.startsWith('Glasgow:'))).toBe(true);
  });
  it('every C, R and L is a passive, resistor arrays included', () => {
    const passives = byRef(/^(C|R|L|RN|FB)\d/);
    expect(passives.length).toBeGreaterThanOrEqual(140);
    for (const fp of passives) expect(partFamily(fp.lib, fp.ref), `${fp.ref} ${fp.lib}`).toBe('passive');
    expect(passives.some((fp) => fp.lib.includes('R_Array'))).toBe(true);
  });
  it('every LED_SMD footprint is an LED, and the SOD diodes are not', () => {
    const leds = model.footprints.filter((fp) => fp.lib.startsWith('LED_SMD:'));
    expect(leds).toHaveLength(12);
    for (const fp of leds) expect(partFamily(fp.lib, fp.ref)).toBe('led');
    const sods = model.footprints.filter((fp) => fp.lib.includes('D_SOD'));
    expect(sods.length).toBeGreaterThan(0);
    for (const fp of sods) expect(partFamily(fp.lib, fp.ref)).toBe('ic');
  });
  it('test points, fiducials, mounting holes, logos and panel tabs stay other', () => {
    const rest = model.footprints.filter((fp) => /^(TestPoint|Fiducial|Symbol|kikit):/.test(fp.lib) || fp.lib.includes('MountingHole') || fp.lib.includes('Logo'));
    expect(rest.length).toBeGreaterThanOrEqual(30);
    for (const fp of rest) expect(partFamily(fp.lib, fp.ref), `${fp.ref} ${fp.lib}`).toBe('other');
  });
});

describe('partFamily — the rules themselves', () => {
  it('reads the library id by token, so a socket is not an IC and a crystal is', () => {
    expect(partFamily('Glasgow:PinSocket_1x08_P1.27mm_Vertical_DNP')).toBe('connector');
    expect(partFamily('Glasgow:Crystal_SMD_3225-4Pin_3.2x2.5mm')).toBe('ic');
    expect(partFamily('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')).toBe('ic');
    expect(partFamily('Capacitor_SMD:C_0402_1005Metric')).toBe('passive');
    expect(partFamily('LED_SMD:LED_0603_1608Metric')).toBe('led');
    expect(partFamily('Connector_PinHeader_1.27mm:PinHeader_2x22_P1.27mm_Vertical_SMD')).toBe('connector');
  });
  it('an LED library wins over the package size it also names', () => {
    expect(partFamily('LED_SMD:LED_0805_2012Metric')).toBe('led');
  });
  it('falls back to the reference prefix when the library says nothing', () => {
    expect(partFamily('MyLib:Thing', 'J7')).toBe('connector');
    expect(partFamily('MyLib:Thing', 'U3')).toBe('ic');
    expect(partFamily('MyLib:Thing', 'Q2')).toBe('ic');
    expect(partFamily('MyLib:Thing', 'C12')).toBe('passive');
    expect(partFamily('', 'R1')).toBe('passive');
    expect(partFamily('MyLib:Thing', 'LED1')).toBe('led');
  });
  it('a bare D is left alone — a diode or an LED, and a wrong tint teaches the wrong thing', () => {
    expect(partFamily('MyLib:Thing', 'D4')).toBe('other');
    expect(partFamily('', '')).toBe('other');
    expect(partFamily('TestPoint:TestPoint_Pad_D1.0mm', 'TP3')).toBe('other');
  });
  it('lists the families the legend shows, other last', () => {
    expect(PART_FAMILIES).toEqual(['ic', 'passive', 'connector', 'led', 'other']);
  });
});
