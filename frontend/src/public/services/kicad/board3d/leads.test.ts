import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { courtyardOf } from './courtyards';
import { bbox } from './geom';
import { FOOT_MM, SHOULDER_SHARE, isChipPackage, isLeadless, leadsOf, localBodyBox, pin1Mark, type LeadSolid } from './leads';
import { placedPadRing } from './pads';
import { partFamily } from './partFamily';
import { readBoardModel } from './readBoardModel';
import type { FootprintModel } from './types';

const glasgow = readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.01);
const fpOf = (ref: string) => glasgow.footprints.find((f) => f.ref === ref)!;
const leads = (fp: FootprintModel) => leadsOf(fp, courtyardOf(fp, 0.01)!, partFamily(fp.lib, fp.ref));
const count = (solids: LeadSolid[], kind: LeadSolid['kind']) => solids.filter((s) => s.kind === kind).length;

describe('leadsOf — Glasgow', () => {
  it('J5, the 2×22 SMD header, has 44 feet and 44 shoulders, one pair per pad', () => {
    const j5 = fpOf('J5');
    expect(j5.lib).toContain('PinHeader_2x22');
    const solids = leads(j5);
    expect(count(solids, 'foot')).toBe(44);
    expect(count(solids, 'shoulder')).toBe(44);
    expect(new Set(solids.filter((s) => s.kind === 'foot').map((s) => s.pad)).size).toBe(44);
  });
  it('a foot lies on its pad, outside the body, and a shoulder climbs from the foot to the body wall', () => {
    const j5 = fpOf('J5');
    const body = courtyardOf(j5, 0.01)!;
    const h = body.heightMm;
    const b = bbox(body.ring.pts);
    for (const s of leads(j5)) {
      if (s.kind === 'foot') {
        expect(s.lo).toBe(0);
        expect(s.hi).toBe(FOOT_MM);
        const pad = j5.pads.find((p) => p.number === s.pad)!;
        const pb = bbox(placedPadRing(pad, j5.place, 0.01).pts), fb = bbox(s.ring.pts);
        // Inside the pad …
        expect(fb.min.x).toBeGreaterThanOrEqual(pb.min.x - 1e-6);
        expect(fb.max.x).toBeLessThanOrEqual(pb.max.x + 1e-6);
        expect(fb.min.y).toBeGreaterThanOrEqual(pb.min.y - 1e-6);
        expect(fb.max.y).toBeLessThanOrEqual(pb.max.y + 1e-6);
        // … and not under the body (J5 is turned 90°: its pads stick out in y).
        const overlapY = Math.min(fb.max.y, b.max.y) - Math.max(fb.min.y, b.min.y);
        const overlapX = Math.min(fb.max.x, b.max.x) - Math.max(fb.min.x, b.min.x);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-6);
      } else if (s.kind === 'shoulder') {
        const levels = s.corners.map((c) => c.level);
        expect(Math.min(...levels)).toBe(0);
        expect(Math.max(...levels)).toBeCloseTo(SHOULDER_SHARE * h, 9);
      }
    }
  });
  it('a C_0402 has two terminations, inside its body rect, one at each pad’s end', () => {
    const c = glasgow.footprints.find((f) => f.place.at.x === 127 && f.place.at.y === 107.6)!;
    expect(c.lib).toBe('Capacitor_SMD:C_0402_1005Metric');
    const body = courtyardOf(c, 0.01)!;
    const solids = leads(c);
    expect(solids.map((s) => s.kind)).toEqual(['termination', 'termination']);
    const b = bbox(body.ring.pts);
    for (const s of solids) {
      if (s.kind === 'shoulder') throw new Error('no shoulders on a chip');
      const t = bbox(s.ring.pts);
      // Inside the body, give or take the 5 µm the metal stands proud.
      expect(t.min.x).toBeGreaterThanOrEqual(b.min.x - 0.006);
      expect(t.max.x).toBeLessThanOrEqual(b.max.x + 0.006);
      expect(t.min.y).toBeGreaterThanOrEqual(b.min.y - 0.006);
      expect(t.max.y).toBeLessThanOrEqual(b.max.y + 0.006);
      // On its own pad's side of the chip, and over that pad.
      const pad = c.pads.find((p) => p.number === s.pad)!;
      const pb = bbox(placedPadRing(pad, c.place, 0.01).pts);
      const mid = { x: (t.min.x + t.max.x) / 2, y: (t.min.y + t.max.y) / 2 };
      expect(mid.x).toBeGreaterThanOrEqual(pb.min.x);
      expect(mid.x).toBeLessThanOrEqual(pb.max.x);
      expect(mid.y).toBeGreaterThanOrEqual(pb.min.y);
      expect(mid.y).toBeLessThanOrEqual(pb.max.y);
      // Full body height and a hair more, so the ends read as metal.
      expect(s.hi).toBeCloseTo(body.heightMm + 0.005, 9);
    }
    expect(new Set(solids.map((s) => s.pad))).toEqual(new Set(['1', '2']));
  });
  it('a BGA draws nothing under itself; the through-hole IDC header gets a post per pin, rising 2 mm past its body', () => {
    const u30 = fpOf('U30');
    expect(u30.lib).toContain('BGA');
    expect(leads(u30)).toEqual([]);
    const idc = glasgow.footprints.find((f) => f.lib.startsWith('Connector_IDC:'))!;
    const solids = leads(idc);
    const tht = idc.pads.filter((p) => p.kind === 'thru_hole' && p.drill != null);
    expect(count(solids, 'post')).toBe(tht.length);
    const body = courtyardOf(idc, 0.01)!;
    for (const s of solids) if (s.kind === 'post') expect(s.hi).toBeCloseTo(body.heightMm + 2, 9);
    const side = Math.max(0.3, 0.64 * tht[0].drill!.d);
    const pb = bbox((solids[0] as { ring: { pts: { x: number; y: number }[] } }).ring.pts);
    expect(Math.min(pb.max.x - pb.min.x, pb.max.y - pb.min.y)).toBeCloseTo(side, 6);
  });
  it('an LED and a test point draw no surface leads', () => {
    const led = glasgow.footprints.find((f) => f.lib.startsWith('LED_SMD:'))!;
    expect(leads(led)).toEqual([]);
    const tp = fpOf('TP5');
    expect(leadsOf(tp, courtyardOf(tp, 0.01)!, partFamily(tp.lib, tp.ref))).toEqual([]);
  });
  it('back-side SOT parts get their leads on their own side of the body, all 6 of a SOT-363', () => {
    const sot = glasgow.footprints.find((f) => f.lib === 'Glasgow:SOT-363_SC-70-6' && f.place.side === 'B')
      ?? glasgow.footprints.find((f) => f.lib === 'Glasgow:SOT-363_SC-70-6')!;
    const solids = leads(sot);
    expect(count(solids, 'foot')).toBe(6);
  });
  it('a QFN with thermal vias gets flat fillets and no studs through its top; a leaded TSSOP keeps its shoulders', () => {
    const u1 = fpOf('U1');
    expect(u1.lib).toContain('QFN-56');
    expect(u1.pads.some((p) => p.kind === 'thru_hole')).toBe(true);
    const solids = leads(u1);
    expect(count(solids, 'post')).toBe(0);
    expect(count(solids, 'shoulder')).toBe(0);
    expect(count(solids, 'foot')).toBeGreaterThan(0);
    for (const s of solids) if (s.kind === 'foot') expect(s.hi).toBe(FOOT_MM);
    const tssop = glasgow.footprints.find((f) => f.lib.startsWith('Package_SO:TSSOP-8'))!;
    expect(count(leads(tssop), 'shoulder')).toBe(8);
  });
  it('a mounting hole draws no post in its own hole', () => {
    const mh = glasgow.footprints.find((f) => f.lib.includes('MountingHole'))!;
    expect(count(leads(mh), 'post')).toBe(0);
  });
  it('an electrolytic can stands on two flat tabs, never on a termination as tall as the can', () => {
    const can = glasgow.footprints.find((f) => f.lib === 'Capacitor_SMD:CP_Elec_6.3x5.9')!;
    const solids = leads(can);
    expect(solids.map((s) => s.kind)).toEqual(['foot', 'foot']);
    for (const s of solids) if (s.kind === 'foot') expect(s.hi).toBe(FOOT_MM);
  });
  it('names: chip size codes (arrays included) are chips, cans are not; QFN/DFN/UDFN/BGA are leadless, SOT and TSSOP are not', () => {
    for (const lib of ['Capacitor_SMD:C_0402_1005Metric', 'Glasgow:R_Array_Convex_4x0402', 'Resistor_SMD:R_1206_3216Metric']) expect(isChipPackage(lib)).toBe(true);
    for (const lib of ['Capacitor_SMD:CP_Elec_6.3x5.9', 'Inductor_SMD:L_Bourns_SRN6045TA', 'Glasgow:SOT-23-6']) expect(isChipPackage(lib)).toBe(false);
    for (const lib of ['Package_DFN_QFN:Cypress_QFN-56-1EP_8x8mm_P0.5mm', 'Glasgow:UDFN-14_3.5x1.35mm_P0.5mm', 'Glasgow:DFN-6-1EP_2x2mm', 'Package_BGA:BGA-121_9.0x9.0mm']) expect(isLeadless(lib)).toBe(true);
    for (const lib of ['Glasgow:SOT-23-6', 'Package_SO:TSSOP-16_4.4x5mm_P0.65mm', 'Glasgow:VSSOP-10_3x3mm_P0.5mm', 'Glasgow:SOT-143']) expect(isLeadless(lib)).toBe(false);
  });
});

describe('the cost of the pass', () => {
  it('outlines, leads and pin-1 marks for all of Glasgow take a small share of its build', () => {
    // Measured alone: 8–20 ms of Glasgow's ~1.07 s build. The bound is loose
    // for a loaded machine and still an order under the 1.5 s budget.
    const t0 = performance.now();
    let solids = 0;
    for (const fp of glasgow.footprints) {
      const body = courtyardOf(fp, 0.01);
      if (body == null) continue;
      const family = partFamily(fp.lib, fp.ref);
      solids += leadsOf(fp, body, family).length;
      pin1Mark(fp, body, family);
    }
    expect(performance.now() - t0).toBeLessThan(250);
    expect(solids).toBeGreaterThan(500);
  });
});

describe('pin1Mark', () => {
  it('sits on the body, in the quadrant of pad 1, on every IC with a pad 1', () => {
    const ics = glasgow.footprints.filter((f) => partFamily(f.lib, f.ref) === 'ic' && f.pads.some((p) => p.number === '1'));
    expect(ics.length).toBeGreaterThan(30);
    let marked = 0;
    for (const fp of ics) {
      const body = courtyardOf(fp, 0.01);
      if (body == null) continue;
      const mark = pin1Mark(fp, body, 'ic');
      if (mark == null) continue;
      marked++;
      expect(mark.r).toBeGreaterThanOrEqual(0.15);
      expect(mark.r).toBeLessThanOrEqual(0.6);
      // Local frame: the mark's centre and pad 1 are on the same side of the body's middle.
      const box = localBodyBox(fp, body)!;
      const t = (-fp.place.rotDeg * Math.PI) / 180;
      const dx = mark.c.x - fp.place.at.x, dy = mark.c.y - fp.place.at.y;
      const local = { x: dx * Math.cos(t) + dy * Math.sin(t), y: -dx * Math.sin(t) + dy * Math.cos(t) };
      const pad = fp.pads.find((p) => p.number === '1')!;
      const midX = (box.min.x + box.max.x) / 2, midY = (box.min.y + box.max.y) / 2;
      expect(Math.sign(local.x - midX), fp.ref).toBe(pad.at.x < midX ? -1 : 1);
      expect(Math.sign(local.y - midY), fp.ref).toBe(pad.at.y < midY ? -1 : 1);
      expect(local.x - mark.r).toBeGreaterThanOrEqual(box.min.x - 1e-6);
      expect(local.x + mark.r).toBeLessThanOrEqual(box.max.x + 1e-6);
    }
    expect(marked).toBeGreaterThan(30);
  });
  it('a passive, and an IC without a pad 1, carry none', () => {
    const c = glasgow.footprints.find((f) => f.lib === 'Capacitor_SMD:C_0402_1005Metric')!;
    expect(pin1Mark(c, courtyardOf(c, 0.01)!, 'passive')).toBeNull();
    const u = glasgow.footprints.find((f) => partFamily(f.lib, f.ref) === 'ic')!;
    expect(pin1Mark({ ...u, pads: u.pads.filter((p) => p.number !== '1' && p.number !== 'A1') }, courtyardOf(u, 0.01)!, 'ic')).toBeNull();
  });
});
