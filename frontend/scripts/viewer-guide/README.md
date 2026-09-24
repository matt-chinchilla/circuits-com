# /viewer guide captures

The pictures in `frontend/public/viewer-guide/*.webp` are real captures of the
Design Viewer on the committed example project ("Try the example project"),
taken from **production** so the BOM shows the catalog buyers see. Re-take
them when the viewer's look changes, before a deploy:

1. `mkdir -p /tmp/viewer-guide-raw`
2. Run `capture.playwright.js` through the Playwright MCP
   (`browser_run_code_unsafe` with `filename` set to this file — the MCP only
   reads files inside the repo). It opens https://circuitcenter.ai/viewer in its
   own 1600×1000 context at deviceScaleFactor 3 with reduced motion (so the 3D
   view does not auto-orbit), clicks "Try the example project", prices the BOM,
   finds U30, shows it on the Board, visits Stackup, shows it in 3D (once as
   framed, once dollied in) and ends on the BOM. It writes stage, canvas,
   part-panel and viewport screenshots to `/tmp/viewer-guide-raw/`. Read-only;
   it never signs in. Use the Playwright MCP, not chrome-devtools: the 3D view
   needs WebGL.
3. `python3 frontend/scripts/viewer-guide/encode.py` — crops each capture
   around a CENTRE and WIDTH given as fractions of the capture, takes the
   height from the output's aspect, resizes and writes WebP (Pillow with WebP
   support; no npm dependency).
4. If a file's pixel size changed, update its `width`/`height` in
   `src/public/pages/viewer/components/guide/guideCopy.ts` (`IMAGES`) — the
   page reserves that box before the picture loads, and `partTour.test.ts`
   fails until the two agree.

## What the tour pictures promise

- **Twice the pixels of the largest box they are drawn in**
  (`partTour.test.ts`, `LARGEST_BOX`): 3D 1680×1120 for a frame up to ~804×536
  CSS px; schematic and board 1280×800 for the 480px phone column (a 3x phone
  draws them from ~1290 device px); the part panel at its native 1005px for a
  340px phone frame. The tour's grid stops growing at 1312px
  (`$tour-max` in `PartTour.module.scss`) so this stays true on wide screens.
- **Shapes the frames are cut to**: 3D 3:2 (the frame crops it around the chip
  by `object-position`), schematic and board 16:10, the part panel its own
  aspect (never cropped).
- **No project-specific names in any frame.** The crops stay clear of the
  schematic's title block, the board's silkscreen title and the workspace's
  project bar; the capture HIDES the part panel's Sheet row for that one frame
  because it names the example's root sheet. Check each file by eye after a
  re-take.
- **The whole tour under ~500 KB** (318 KB on 2026-09-24; all nine files
  428 KB).

The copy beside the pictures must stay true of what they show: the 2026-09-24
production BOM priced 32 of 66 lines and U30 had no distributor stock, so the
tour says the part panel shows "what our catalog knows", never a price.
