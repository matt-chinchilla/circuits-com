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

/** Read a project WITHOUT publishing it. The pair of `publishDesign`, for a
 *  caller that has to look at the result before deciding whether this design is
 *  one it can use — /bom, which refuses a project it cannot price and must not
 *  evict the session the reader already has open while doing so. */
export function readDesign(project: KicadProject): DesignSession {
  const read = readSchematic(project);
  return { project, parsed: read.result, refs: read.refs };
}

export function publishDesign(session: DesignSession): DesignSession {
  current = session;
  return session;
}

/** Read and publish in one step — /viewer, which opens ANY readable project
 *  (a board-only design has no BOM and is still worth drawing). */
export function openDesign(project: KicadProject): DesignSession {
  return publishDesign(readDesign(project));
}

export const NO_BOM_LINES =
  'No BOM lines were read from that schematic. Power, virtual and unreferenced symbols, and anything marked not-in-BOM, are left out — there is nothing here to price.';

/**
 * Why this design cannot produce a priced BOM, or null when it can.
 *
 * The pricing tool's admission test, and the reason it is a FUNCTION rather
 * than a boolean: the caller has to tell the reader which of the three it was.
 * `/viewer` deliberately does not use it — it opens a board-only project quite
 * happily and simply shows no BOM tab.
 *
 * A project with no schematic ROOT is caught by the first branch, not a branch
 * of its own: `readSchematic` returns an error parse for exactly that case, and
 * its sentence ("No schematic in this project — drop the .kicad_sch files to
 * read a BOM.") is better than one written here. `designSession.test.ts` pins
 * that coupling, so it cannot quietly stop holding.
 */
export function unpriceableReason(session: DesignSession): string | null {
  if (session.parsed.error != null) return session.parsed.error;
  if (session.parsed.lines.length === 0) return NO_BOM_LINES;
  return null;
}

export function getDesignSession(): DesignSession | null {
  return current;
}

export function clearDesignSession(): void {
  current = null;
}
