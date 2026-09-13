// frontend/src/public/services/designSession.ts
// Module-memory holder for the current design (the category-memo pattern):
// /viewer and /bom share one project and ONE parse of its BOM, so a round trip
// between the pages costs one /api/bom/match, not three (spec §7.1). Dies on
// reload — anonymous visitors are browser-only by ruling (D3).
import { readSchematic, type RefLocation } from '@public/services/kicad/schematicBom';
import type { KicadProject } from '@public/services/kicad/types';
import type { ParseResult } from '@public/services/bom/parseBom';

export interface DesignSession {
  project: KicadProject;
  parsed: ParseResult;
  refs: Map<string, RefLocation>;
}

let current: DesignSession | null = null;

export function openDesign(project: KicadProject): DesignSession {
  const read = readSchematic(project);
  current = { project, parsed: read.result, refs: read.refs };
  return current;
}

export function getDesignSession(): DesignSession | null {
  return current;
}

export function clearDesignSession(): void {
  current = null;
}
