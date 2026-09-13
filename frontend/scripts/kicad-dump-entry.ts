// frontend/scripts/kicad-dump-entry.ts
// Bundled by kicad-dump.mjs for node: reads a directory or zip through the
// SAME reader the pages use and prints what it found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildProject } from '@public/services/kicad/project';
import { readSchematic } from '@public/services/kicad/schematicBom';
import { readStackup } from '@public/services/kicad/boardStackup';
import { KicadReadError } from '@public/services/kicad/types';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export async function dump(target: string): Promise<void> {
  try {
    const files = statSync(target).isDirectory()
      ? walk(target).map((p) => new File([readFileSync(p)], relative(target, p).split('\\').join('/')))
      : [new File([readFileSync(target)], target.split('/').pop() ?? 'project.zip')];
    const project = await buildProject(files);
    const sch = readSchematic(project);
    const board = project.board == null ? null : readStackup(project.files.get(project.board) as string);
    const out = {
      name: project.name,
      root: project.root,
      sheets: project.sheets.map((s) => s.path),
      board: project.board,
      missingSheets: project.missingSheets,
      warnings: [...project.warnings, ...sch.result.warnings],
      error: sch.result.error,
      instances: sch.instances,
      lines: sch.result.lines.length,
      references: [...sch.refs.keys()].sort(),
      bom: sch.result.lines.map((l) => ({ qty: l.qty, refs: l.refs.join(' '), value: l.value, footprint: l.footprint, mpn: l.mpn, manufacturer: l.manufacturer, dnp: l.dnp })),
      stackup: board,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err) {
    // The reader's one error contract: a KicadReadError is a READING verdict
    // (kicad5 | cap | archive | empty | unreadable), not a crash, so it prints
    // as JSON the owner can compare like any other run. Anything else is a bug
    // and keeps its stack.
    if (!(err instanceof KicadReadError)) throw err;
    process.stdout.write(`${JSON.stringify({ error: { kind: err.kind, message: err.message } }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
