# KiCad import-claim verification (2026-09-24), via GitLab API tree/file/commit queries on kicad/code/kicad
Tags checked: 4.0.0 5.0.0 6.0.0 7.0.0 8.0.0 8.0.1 8.0.2 9.0.0 9.0.1 9.0.2 9.0.3 10.0.0 10.0.6 master.
- Altium ASCII SchDoc: commit 2024-02-29; absent 8.0.0/8.0.1, present 8.0.2; listed in 9.0.0 notes.
- Altium PrjPcb project import: absent 9.0.0/9.0.1/9.0.2, present 9.0.3 (2025-07-07) and 10.0.x.
- Altium variants: f3441c00 2026-03-12, present 10.0.0.
- kicad-cli pcb import: 10.0.0+ (pads, altium, eagle, cadstar, fabmaster, pcad, solidworks); sch import master only.
- 10.0.6 pcb_io: allegro altium cadstar eagle easyeda easyedapro fabmaster geda ipc2581 odbpp pads pcad
- master adds: autotrax (2026-06-03), diptrace (2026-05-31), sprint_layout (2026-03-20), PADS binary registration, EasyEDA Pro v3, Eagle binary.
- 10.0.6 sch_io: altium cadstar eagle easyeda easyedapro geda ltspice pads (+db/http); master adds diptrace, pcad (2026-07-03), orcad (2026-07-21).
- EasyEDA Std project import ("Import EasyEDA Std Backup", zip) exists in import_project.cpp since 8.0.0.
- Licences per file vary GPL-2+/GPL-3+ (pads_parser, easyeda*, pcb_io_fabmaster, pcb_io_geda = GPL-2+).
- GitHub: OpenOrCadParser + OpenAllegroParser ARCHIVED; parseagle MIT OR Apache-2.0; Swoop GPL-2.0-only.
- Firecrawl: out of credits; kicad.org blog fetched with curl.
