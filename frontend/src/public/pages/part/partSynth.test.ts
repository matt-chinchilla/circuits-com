import { describe, expect, it } from 'vitest';
import { buildInventoryHistory, extractSpecs, hashString, mulberry32 } from './partSynth';

describe('deterministic PRNG', () => {
  it('same seed yields the same sequence', () => {
    const a = mulberry32(hashString('abc'));
    const b = mulberry32(hashString('abc'));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('different seeds diverge', () => {
    const a = mulberry32(hashString('part-1'))();
    const b = mulberry32(hashString('part-2'))();
    expect(a).not.toBe(b);
  });
});

describe('buildInventoryHistory', () => {
  it('is deterministic per seed and anchored at current stock', () => {
    const h1 = buildInventoryHistory('some-uuid', 5000);
    const h2 = buildInventoryHistory('some-uuid', 5000);
    expect(h1).toEqual(h2);
    expect(h1[0]).toEqual({ daysAgo: 0, stock: 5000 });
    expect(h1).toHaveLength(366); // today + 365 days back
  });

  it('never goes negative, even from zero stock', () => {
    for (const p of buildInventoryHistory('zero-part', 0)) {
      expect(p.stock).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('extractSpecs', () => {
  it('parses electrical values out of real description text', () => {
    const specs = extractSpecs(
      '100V 6A Schottky rectifier diode, 0.55V forward, TO-220AC, -55 to +150°C',
    );
    const byLabel = Object.fromEntries(specs.map(s => [s.label, s.value]));
    expect(byLabel['Voltage rating']).toBe('100 V');
    expect(byLabel['Current rating']).toBe('6 A');
    expect(byLabel['Package']).toBe('TO-220AC');
    expect(byLabel['Operating temp']).toBe('-55°C to +150°C');
  });

  it('parses passive-component units', () => {
    const specs = extractSpecs('10uF 25V ceramic capacitor, X7R, ±10%, 0805');
    const byLabel = Object.fromEntries(specs.map(s => [s.label, s.value]));
    expect(byLabel['Capacitance']).toBe('10 µF');
    expect(byLabel['Voltage rating']).toBe('25 V');
    expect(byLabel['Tolerance']).toBe('±10%');
    expect(byLabel['Package']).toBe('0805');
  });

  it('returns empty for null or spec-free text', () => {
    expect(extractSpecs(null)).toEqual([]);
    expect(extractSpecs('General purpose connector accessory')).toEqual([]);
  });

  it('never duplicates a label', () => {
    const specs = extractSpecs('3.3V regulator 5V input SOT-23');
    const labels = specs.map(s => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('does not misread a TO-220A package as a 220 A current rating', () => {
    const byLabel = Object.fromEntries(
      extractSpecs('TO-220A rectifier').map(s => [s.label, s.value]),
    );
    expect(byLabel['Current rating']).toBeUndefined();
    expect(byLabel['Package']).toBe('TO-220A');
  });

  it('parses the Ω symbol, not just spelled-out Ohm', () => {
    const byLabel = Object.fromEntries(
      extractSpecs('10kΩ pull-up resistor, 0402').map(s => [s.label, s.value]),
    );
    expect(byLabel['Resistance']).toBe('10 kΩ');
  });
});
