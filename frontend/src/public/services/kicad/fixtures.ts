// frontend/src/public/services/kicad/fixtures.ts
// Fixture access for the reader tests (node only — vitest runs in the node
// environment). Real files live under ./fixtures/<set>/ with a LICENSE and a
// SOURCE beside them; the synthetic documents below are hand-written minimal
// KiCad files, one per reader rule, like the BOM parser's own fixtures.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, 'fixtures');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every file of a set as `File`s named by their path relative to the set. */
export function fixtureFiles(set: string): File[] {
  const dir = join(ROOT, set);
  return walk(dir)
    .filter((p) => !p.endsWith('/LICENSE') && !p.endsWith('/SOURCE'))
    .map((p) => new File([readFileSync(p)], relative(dir, p).split('\\').join('/')));
}

export function fixtureText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

export function hasFixture(set: string): boolean {
  return existsSync(join(ROOT, set));
}

/** A symbol block factory for synthetic schematics. */
export function symbol(opts: {
  lib: string; uuid: string; ref: string; value: string; footprint?: string; unit?: number;
  inBom?: boolean; dnp?: boolean; extra?: Record<string, string>; instances?: { path: string; ref: string; unit?: number }[];
}): string {
  const props = [
    `(property "Reference" "${opts.ref}" (at 0 0 0))`,
    `(property "Value" "${opts.value}" (at 0 0 0))`,
    `(property "Footprint" "${opts.footprint ?? ''}" (at 0 0 0))`,
    ...Object.entries(opts.extra ?? {}).map(([k, v]) => `(property "${k}" "${v}" (at 0 0 0))`),
  ].join('\n    ');
  const inst = opts.instances
    ? `(instances (project "synth" ${opts.instances.map((i) => `(path "${i.path}" (reference "${i.ref}") (unit ${i.unit ?? 1}))`).join(' ')}))`
    : '';
  return `(symbol (lib_id "${opts.lib}") (at 10 10 0) (unit ${opts.unit ?? 1}) (in_bom ${opts.inBom === false ? 'no' : 'yes'}) (on_board yes) (dnp ${opts.dnp ? 'yes' : 'no'}) (uuid "${opts.uuid}")
    ${props}
    ${inst})`;
}

export function schematic(opts: { uuid: string; version?: number; libSymbols?: string; body: string; symbolInstances?: string }): string {
  return `(kicad_sch (version ${opts.version ?? 20250114}) (generator "eeschema") (uuid "${opts.uuid}") (paper "A4")
  (lib_symbols ${opts.libSymbols ?? ''})
  ${opts.body}
  ${opts.symbolInstances ?? ''}
)`;
}

export function sheet(opts: { uuid: string; file: string; name?: string }): string {
  return `(sheet (at 50 50) (size 20 10) (uuid "${opts.uuid}") (property "Sheetname" "${opts.name ?? opts.file}" (at 0 0 0)) (property "Sheetfile" "${opts.file}" (at 0 0 0)))`;
}

export const ROOT_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const SHEET_A_UUID = 'bbbbbbbb-0000-4000-8000-000000000002';
export const SHEET_B_UUID = 'bbbbbbbb-0000-4000-8000-000000000003';
