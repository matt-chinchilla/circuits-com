import { describe, expect, it } from 'vitest';

import type { AdminManufacturerDetail } from '@admin/types/manufacturers';

import { coverageLabel, promoteBlockedReason, promoteFailure } from './supplierLink';

function detail(over: Partial<AdminManufacturerDetail> = {}): AdminManufacturerDetail {
  return {
    id: 'm-1',
    name: 'Vishay',
    slug: 'vishay',
    website: 'https://vishay.com',
    source: 'csv',
    catalog_part_count: 42,
    external_part_count: null,
    linked_supplier_id: null,
    linked_supplier_name: null,
    description: null,
    logo_url: null,
    canonical_key: 'vishay',
    external_part_count_as_of: null,
    aliases: [],
    merge_candidates: [],
    linked_supplier_sponsorships: [],
    ...over,
  };
}

describe('coverageLabel', () => {
  it('labels the ratio so the external number can never read as our inventory', () => {
    expect(coverageLabel(1204, 5000)).toBe('1,204 of ~5,000 listed');
  });

  it('prints the catalog count alone when there is no external snapshot', () => {
    expect(coverageLabel(1204, null)).toBe('1,204');
    // 0 means "never measured", not "they list nothing" — same treatment.
    expect(coverageLabel(7, 0)).toBe('7');
    expect(coverageLabel(7, -1)).toBe('7');
  });

  it('still shows the ratio when our catalog exceeds the (stale) snapshot', () => {
    // Truth over tidiness: a catalog above the snapshot is a data-quality
    // signal the admin should SEE, not something to hide behind a bare count.
    expect(coverageLabel(120, 50)).toBe('120 of ~50 listed');
  });

  it('handles zero', () => {
    expect(coverageLabel(0, 900)).toBe('0 of ~900 listed');
    expect(coverageLabel(0, null)).toBe('0');
  });
});

describe('promoteBlockedReason', () => {
  it('allows promotion for an unlinked, named manufacturer', () => {
    expect(promoteBlockedReason(detail())).toBeNull();
  });

  it('blocks when a supplier is already linked, and names it', () => {
    expect(
      promoteBlockedReason(
        detail({ linked_supplier_id: 's-9', linked_supplier_name: 'Vishay Intertechnology' }),
      ),
    ).toBe('Already linked to Vishay Intertechnology.');
  });

  it('falls back to a generic noun when the link has no name', () => {
    expect(promoteBlockedReason(detail({ linked_supplier_id: 's-9' }))).toBe(
      'Already linked to a supplier.',
    );
  });

  it('blocks a nameless manufacturer — the supplier row would be born nameless', () => {
    expect(promoteBlockedReason(detail({ name: '   ' }))).toMatch(/no name/);
  });
});

describe('promoteFailure', () => {
  it('opens the picker for the ONE conflict a human resolves in place', () => {
    const f = promoteFailure('supplier_name_exists_use_link');
    expect(f.showPicker).toBe(true);
    expect(f.message).toMatch(/Link this manufacturer/);
  });

  it('keeps the picker shut for every other conflict', () => {
    for (const code of ['already_linked', 'supplier_already_linked']) {
      expect(promoteFailure(code).showPicker).toBe(false);
    }
  });

  it('never leaks a raw machine code for the conflicts it knows', () => {
    for (const code of ['supplier_name_exists_use_link', 'already_linked', 'supplier_already_linked']) {
      expect(promoteFailure(code).message).not.toContain('_');
    }
  });

  it('falls back to a sentence when there is no detail at all', () => {
    expect(promoteFailure(undefined).message).toBe(
      'Could not promote this manufacturer. Please try again.',
    );
  });

  it('passes through prose the server (or apiErrorDetail) already wrote', () => {
    expect(promoteFailure('Editing is disabled in the demo.').message).toBe(
      'Editing is disabled in the demo.',
    );
  });
});
