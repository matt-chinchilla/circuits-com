import { describe, expect, it } from 'vitest';
import { humanFootprint, labelLines } from './partLabel';

describe('the label text', () => {
  it("drops the library and opens the underscores — the owner's J5, word for word", () => {
    expect(humanFootprint('Connector_PinHeader_1.27mm:PinHeader_2x22_P1.27mm_Vertical_SMD')).toBe('PinHeader 2x22 P1.27mm Vertical SMD');
    expect(humanFootprint('Glasgow:PinHeader_2x22_P1.27mm_Vertical__SMD')).toBe('PinHeader 2x22 P1.27mm Vertical SMD');
    expect(humanFootprint('SOIC-8_3.9x4.9mm_P1.27mm')).toBe('SOIC-8 3.9x4.9mm P1.27mm');
  });
  it('designator first, then value and footprint', () => {
    expect(labelLines({ ref: 'C1', value: '100n', footprint: 'Capacitor_SMD:C_0402_1005Metric' }))
      .toEqual({ title: 'C1', detail: '100n · C 0402 1005Metric' });
  });
  it('a value that only repeats the footprint is said once', () => {
    expect(labelLines({ ref: 'J5', value: 'PinHeader_2x22_P1.27mm', footprint: 'Glasgow:PinHeader_2x22_P1.27mm_Vertical__SMD' }))
      .toEqual({ title: 'J5', detail: 'PinHeader 2x22 P1.27mm Vertical SMD' });
    expect(labelLines({ ref: 'U1', value: 'SOT-23-5', footprint: 'Glasgow:SOT-23-5' }).detail).toBe('SOT-23-5');
  });
  it('says only what the sources know', () => {
    expect(labelLines({ ref: 'R7', value: '10k', footprint: null })).toEqual({ title: 'R7', detail: '10k' });
    expect(labelLines({ ref: 'R7', value: null, footprint: 'Resistor_SMD:R_0402_1005Metric' }).detail).toBe('R 0402 1005Metric');
    expect(labelLines({ ref: 'TP3', value: '  ', footprint: null })).toEqual({ title: 'TP3', detail: null });
  });
});
