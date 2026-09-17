// The founding-distributor flag's three silent failure modes (migration 054).
//
// None of them throws, and none of them is visible in a quick click-through —
// the form still saves, the row still renders, the flag is just wrong:
//
//   1. the payload drops `founder`, so every unrelated edit (a phone number, a
//      logo) silently un-founds a founding distributor on save;
//   2. the hydrate loses its `?? false`, so a payload without the key feeds
//      `undefined` to a controlled checkbox and React flips it to uncontrolled;
//   3. the list chip's rule disappears, and a CSS-module class assertion could
//      not tell — vitest runs with `css` at its default FALSE, so `styles.foo`
//      echoes the key back whether or not the rule exists.
//
// So this is a SOURCE-level witness (the `bomPage.test.ts` / StackupPanel
// pattern): it reads the files off disk and asserts on the text. The admin
// suppliers form is a big JSX page with a file upload, a cropper and a router
// in it; standing all that up in happy-dom to check one checkbox would cost far
// more than it proves.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const form = readFileSync(join(__dirname, './form/index.tsx'), 'utf8');
const list = readFileSync(join(__dirname, './list/index.tsx'), 'utf8');
const listScss = readFileSync(join(__dirname, './list/SuppliersPage.module.scss'), 'utf8');

describe('the supplier form carries the founder flag both ways', () => {
  it('sends it in the save payload', () => {
    // The one that silently un-founds a distributor if it is dropped: the
    // backend takes `exclude_unset`, so an ABSENT key leaves the row alone —
    // but this form always sends a full object, so the key going missing means
    // every save writes the form's idea of the flag, not the row's.
    expect(form).toMatch(/founder:\s*form\.founder\b/);
  });

  it('hydrates an existing supplier with a bool, never undefined', () => {
    // `?? false`, not `||` and not a bare read: the checkbox is controlled, and
    // `undefined` would make React swap it to uncontrolled mid-edit.
    expect(form).toMatch(/founder:\s*s\.founder\s*\?\?\s*false/);
  });

  it('keeps the field addressable for the wizard/tour anchors', () => {
    expect(form).toContain('data-field="founder"');
  });
});

describe('the suppliers list marks a founding distributor', () => {
  it('renders the chip only when the flag is set', () => {
    expect(list).toMatch(/supplier\.founder\s*&&/);
    expect(list).toContain('styles.founderChip');
  });

  it('really defines .founderChip', () => {
    // A CSS-module class assertion proves nothing here (css: false), so the
    // rule's EXISTENCE needs the stylesheet itself — and it must carry at
    // least one declaration, or the module export comes back undefined.
    const rule = listScss.match(/\.founderChip\s*\{([^}]*)\}/);
    expect(rule, '.founderChip must exist in SuppliersPage.module.scss').not.toBeNull();
    expect(rule?.[1].trim().length).toBeGreaterThan(0);
  });
});
