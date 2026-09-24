# /viewer guide captures

The pictures in `frontend/public/viewer-guide/*.webp` are real captures of the
Design Viewer on the committed example project (Glasgow revC3, 0BSD), taken
from **production** so the BOM shows the catalog buyers see. Re-take them when
the viewer's look changes, before a deploy:

1. `mkdir -p /tmp/viewer-guide-raw`
2. Run `capture.playwright.js` through the Playwright MCP
   (`browser_run_code_unsafe` with `filename` set to this file). It opens
   https://circuitcenter.ai/viewer in its own 1440×900 @2x context, clicks
   "Try the example project", finds U30, shows it on the Board, visits
   Stackup, 3D and BOM, and writes element screenshots (the stage, the part
   drawer, the viewport) to `/tmp/viewer-guide-raw/`. Read-only; it never signs in.
3. `python3 frontend/scripts/viewer-guide/encode.py` — crops each capture by
   FRACTIONS of its element's box, resizes to twice the largest size the guide
   draws it at, and writes WebP (Pillow with WebP support; no npm dependency).
4. If a file's pixel size changed, update its `width`/`height` in
   `src/public/pages/viewer/components/guide/guideCopy.ts` (`IMAGES`) — the
   guide reserves that box before the picture loads.

Keep the set well under ~350 KB (it was ~157 KB on 2026-09-24). The copy beside
the pictures must stay true of what they show: the 2026-09-24 production BOM
priced 32 of 66 lines and U30 had no distributor stock, so the tour says the
part panel shows "what our catalog knows", never a price.
