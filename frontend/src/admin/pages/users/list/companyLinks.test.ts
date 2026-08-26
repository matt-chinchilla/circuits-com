import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLinkPatch,
  currentLinks,
  hasLinkChanges,
  manufacturerIdsToResolve,
  normalizeLink,
} from './companyLinks';

const NONE = { supplier_id: null, manufacturer_id: null };

describe('buildLinkPatch', () => {
  it('sets BOTH links in one save', () => {
    // The case the roster has to support: a company that distributes AND
    // manufactures (Avnet). Presenting these as a choice between two would
    // make that company unrepresentable.
    const patch = buildLinkPatch(NONE, { supplier_id: 'sup-1', manufacturer_id: 'mfr-1' });
    expect(patch).toEqual({ supplier_id: 'sup-1', manufacturer_id: 'mfr-1' });
  });

  it('sends only what changed', () => {
    const current = { supplier_id: 'sup-1', manufacturer_id: 'mfr-1' };
    expect(buildLinkPatch(current, { supplier_id: 'sup-2', manufacturer_id: 'mfr-1' })).toEqual({
      supplier_id: 'sup-2',
    });
    expect(buildLinkPatch(current, { supplier_id: 'sup-1', manufacturer_id: 'mfr-2' })).toEqual({
      manufacturer_id: 'mfr-2',
    });
  });

  it('sends an EXPLICIT null to clear a link', () => {
    // The server reads model_dump(exclude_unset=True): an omitted key means
    // "leave alone", so an unlink has to arrive as a present null or the old
    // company stays attached and the tier never drops.
    const patch = buildLinkPatch({ supplier_id: 'sup-1', manufacturer_id: 'mfr-1' }, NONE);
    expect(patch).toEqual({ supplier_id: null, manufacturer_id: null });
    expect('supplier_id' in patch).toBe(true);
    expect('manufacturer_id' in patch).toBe(true);
  });

  it('is empty when nothing moved', () => {
    const current = { supplier_id: 'sup-1', manufacturer_id: null };
    expect(buildLinkPatch(current, { supplier_id: 'sup-1', manufacturer_id: null })).toEqual({});
    expect(hasLinkChanges(buildLinkPatch(current, current))).toBe(false);
    // And the picker's "— none —" value is not a change away from no link.
    expect(buildLinkPatch(NONE, { supplier_id: '', manufacturer_id: '' })).toEqual({});
  });

  it('reads a row the API sent, nulls and absent keys alike', () => {
    expect(currentLinks({ supplier_id: null, manufacturer_id: undefined })).toEqual(NONE);
    expect(currentLinks({ supplier_id: 'sup-1' })).toEqual({
      supplier_id: 'sup-1',
      manufacturer_id: null,
    });
    expect(hasLinkChanges(buildLinkPatch(currentLinks({ supplier_id: 'sup-1' }), {
      supplier_id: 'sup-1',
      manufacturer_id: null,
    }))).toBe(false);
  });
});

describe('normalizeLink', () => {
  it('reads every spelling of "no link" as null', () => {
    expect(normalizeLink('')).toBeNull();
    expect(normalizeLink('   ')).toBeNull();
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink(undefined)).toBeNull();
  });

  it('keeps an id', () => {
    expect(normalizeLink('mfr-1')).toBe('mfr-1');
  });
});

describe('manufacturerIdsToResolve', () => {
  it('collects the distinct linked ids', () => {
    // The roster carries manufacturer_id but no name, so the page resolves the
    // handful that are linked — once each, not once per row.
    expect(
      manufacturerIdsToResolve([
        { manufacturer_id: 'mfr-1' },
        { manufacturer_id: null },
        { manufacturer_id: 'mfr-1' },
        { manufacturer_id: 'mfr-2' },
        { manufacturer_id: undefined },
      ]),
    ).toEqual(['mfr-1', 'mfr-2']);
  });

  it('is empty for a roster with no links — the launch state', () => {
    expect(manufacturerIdsToResolve([{ manufacturer_id: null }])).toEqual([]);
    expect(manufacturerIdsToResolve([])).toEqual([]);
  });
});

describe('the roster actually offers both controls', () => {
  // No renderer in this harness, so the wiring is asserted against the source.
  // Worth asserting: the page shipped with ONLY the Activate toggle, so what
  // has to keep holding is that the two links are reachable at all — and that
  // they are two controls, saved in ONE patch, rather than one either/or.
  const here = new URL('.', import.meta.url);
  const page = readFileSync(fileURLToPath(new URL('index.tsx', here)), 'utf8');
  const editor = readFileSync(fileURLToPath(new URL('CompanyLinkEditor.tsx', here)), 'utf8');

  it('mounts the editor from the roster', () => {
    expect(page).toContain('<CompanyLinkEditor');
    expect(page).toMatch(/Link company|Change company/);
  });

  it('offers a distributor control AND a manufacturer control', () => {
    expect(editor).toContain('Distributor (supplier)');
    expect(editor).toContain('Manufacturer');
    // Two separate pieces of state — a single `linkKind`-style value would be
    // the either/or this must not become.
    expect(editor).toMatch(/setSupplierId/);
    expect(editor).toMatch(/setManufacturer\(/);
  });

  it('saves through buildLinkPatch, in one request', () => {
    expect(editor).toContain('buildLinkPatch(currentLinks(user)');
    // ONE call site: two sequential PATCHes would leave a half-linked account
    // behind whenever the second one failed.
    expect(editor.match(/\.updateUser\(/g) ?? []).toHaveLength(1);
  });
});
