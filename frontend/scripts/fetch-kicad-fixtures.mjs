// frontend/scripts/fetch-kicad-fixtures.mjs
// Downloads the open-hardware fixture corpus at PINNED commits and writes a
// SOURCE + LICENSE beside each set. Run once; the files are committed.
// KiCad's own demo projects are GPL-3.0-or-later and are only written when the
// repo root carries LICENSE (spec D6) — otherwise they are skipped with a note.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '../src/public/services/kicad/fixtures');
const ROOT = resolve(import.meta.dirname, '../..');

const SETS = [
  {
    dir: 'glasgow-revC3',
    base: 'https://raw.githubusercontent.com/GlasgowEmbedded/glasgow/49e29452a3372fcc5aea790c080c0be554d15800',
    files: ['glasgow.kicad_pro', 'glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch', 'glasgow.kicad_pcb'].map((f) => [`hardware/boards/glasgow/revC3/${f}`, f]),
    licenseUrl: 'https://raw.githubusercontent.com/GlasgowEmbedded/glasgow/49e29452a3372fcc5aea790c080c0be554d15800/LICENSE-0BSD.txt',
    source: 'Glasgow Interface Explorer, hardware revC3 — https://github.com/GlasgowEmbedded/glasgow @ 49e29452a3372fcc5aea790c080c0be554d15800 (2026-09-11), 0BSD. Retrieved 2026-09-12.',
  },
  {
    dir: 'bad-thing-panel',
    base: 'https://raw.githubusercontent.com/Pakequis/Bad-Thing-of-the-Edge-keyboard/f7e73685d0bc05957b2d3bedc635b2414c79a013',
    files: ['panel.kicad_pro', 'panel.kicad_sch', 'panel.kicad_pcb'].map((f) => [`Hardware/Panel-board/${f}`, f]),
    licenseUrl: 'https://raw.githubusercontent.com/Pakequis/Bad-Thing-of-the-Edge-keyboard/f7e73685d0bc05957b2d3bedc635b2414c79a013/LICENSE',
    source: 'Bad Thing of the Edge keyboard, panel board — https://github.com/Pakequis/Bad-Thing-of-the-Edge-keyboard @ f7e73685d0bc05957b2d3bedc635b2414c79a013 (2026-04-08), MIT. Retrieved 2026-09-12.',
  },
  {
    dir: 'kicad-demos',
    gplOnly: true,
    base: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/demos',
    files: [
      ['complex_hierarchy/complex_hierarchy.kicad_pro', 'complex_hierarchy/complex_hierarchy.kicad_pro'],
      ['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/complex_hierarchy.kicad_sch'],
      ['complex_hierarchy/ampli_ht.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch'],
      ['complex_hierarchy/complex_hierarchy.kicad_pcb', 'complex_hierarchy/complex_hierarchy.kicad_pcb'],
      ['stickhub/StickHub.kicad_pcb', 'stickhub/StickHub.kicad_pcb'],
    ],
    licenseUrl: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/LICENSE.README',
    source: 'KiCad demo projects — https://gitlab.com/kicad/code/kicad @ a8d6201d6bc1739943ea51b3bc18d8d691503539 (2026-09-12), GPL-3.0-or-later per LICENSE.README. Retrieved 2026-09-12.',
  },
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

for (const set of SETS) {
  if (set.gplOnly && !existsSync(join(ROOT, 'LICENSE'))) {
    console.log(`skip ${set.dir}: repo has no LICENSE yet (spec D6) — GPL fixtures wait for it`);
    continue;
  }
  for (const [remote, local] of set.files) {
    const target = join(OUT, set.dir, local);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, await fetchText(`${set.base}/${remote}`));
    console.log(`wrote ${set.dir}/${local}`);
  }
  writeFileSync(join(OUT, set.dir, 'LICENSE'), await fetchText(set.licenseUrl));
  writeFileSync(join(OUT, set.dir, 'SOURCE'), `${set.source}\n`);
}

writeFileSync(join(OUT, 'kicad5-header.sch'), 'EESchema Schematic File Version 2\nEELAYER 25 0\n');
console.log('done');
