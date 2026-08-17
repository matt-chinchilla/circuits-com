import { describe, expect, it } from 'vitest';
import { packageFamily } from './packageArt';

describe('packageFamily', () => {
  it('maps the common tokens the spec parser emits', () => {
    expect(packageFamily('DFN-10')).toBe('qfn');
    expect(packageFamily('QFN-24')).toBe('qfn');
    expect(packageFamily('SOT-23')).toBe('sot');
    expect(packageFamily('SOIC-8')).toBe('soic');
    expect(packageFamily('TSSOP-14')).toBe('soic');
    expect(packageFamily('TO-220AC')).toBe('to');
    expect(packageFamily('DIP-8')).toBe('dip');
    expect(packageFamily('PDIP-14')).toBe('dip');
    expect(packageFamily('LQFP-48')).toBe('qfp');
    expect(packageFamily('BGA-256')).toBe('bga');
    expect(packageFamily('0805')).toBe('chip');
  });

  it('routes two-terminal diode packages to the axial art, not SOT', () => {
    expect(packageFamily('SOD-123')).toBe('axial');
    expect(packageFamily('SOD-323')).toBe('axial');
    expect(packageFamily('DO-214AC')).toBe('axial');
    expect(packageFamily('SMA')).toBe('axial');
  });

  it('returns null for unknown or missing tokens', () => {
    expect(packageFamily(null)).toBeNull();
    expect(packageFamily(undefined)).toBeNull();
    expect(packageFamily('CHIPLED-6')).toBeNull();
    expect(packageFamily('MODULE')).toBeNull();
  });
});
