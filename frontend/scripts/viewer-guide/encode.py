"""Turn the raw captures from capture.playwright.js into the guide's WebP files.

Each crop is a CENTRE and a WIDTH, both fractions of the raw capture (the
stage, the 3D canvas, the part panel, the viewport), never pixel positions, so
a re-capture at another window size lands on the same content. The crop's
height follows from the output's own aspect ratio, so every file comes out at
exactly the size `guideCopy.ts` (IMAGES) reserves for it.

The tour's four pictures (tour-*) are sized to at least twice the largest box
the tour draws them in (the 3D frame tops out near 810x540 CSS px; the
schematic and board frames at 480 wide in the phone column, where a 3x screen
draws them from ~1290 device px; the part panel at 340 wide on a phone); `partTour.test.ts` holds those numbers (LARGEST_BOX) and fails
if a file shrinks below them. No frame shows the example project's name: the
crops stay clear of title blocks, silkscreen titles and the project bar, and
the capture hides the part panel's Sheet row.

    python3 frontend/scripts/viewer-guide/encode.py [RAW_DIR]

Needs Pillow built with WebP (python3 -c "from PIL import features; print(features.check('webp'))").
"""
import os
import sys

from PIL import Image

RAW = sys.argv[1] if len(sys.argv) > 1 else '/tmp/viewer-guide-raw'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'viewer-guide')

# name: (source, (centre x, centre y, width) as fractions or None for the whole
#        capture, (output width, output height or None to keep the capture's
#        aspect), quality)
JOBS = {
    # The tour: U30 followed across the views.
    'tour-3d-u30': ('3d.png', (0.615, 0.404, 0.75), (1680, 1120), 80),
    'tour-schematic-u30': ('sch.png', (0.512, 0.674, 0.624), (1280, 800), 80),
    'tour-board-u30': ('brd.png', (0.5, 0.5, 0.64), (1280, 800), 74),
    'tour-panel-u30': ('panel.png', None, (1005, None), 86),
    # "What each file becomes": one small picture per view.
    'schematic': ('sch-root.png', (0.458, 0.397, 0.796), (360, 242), 80),
    'bom': ('bom.png', (0.42625, 0.6584, 0.675), (420, 232), 80),
    'board-u30': ('brd.png', (0.5, 0.543, 0.7), (600, 415), 74),
    'stackup': ('stackup.png', (0.37, 0.23, 0.71), (360, 155), 80),
    'board-3d-u30': ('3d-fit.png', (0.5, 0.537, 0.8), (820, 581), 74),
}


def crop_box(size, frac, out_w, out_h):
    """The crop around (cx, cy) of width wf, as tall as the output's aspect
    needs, slid back inside the capture if it runs over an edge."""
    w, h = size
    cx, cy, wf = frac
    bw = wf * w
    bh = bw * out_h / out_w
    if bh > h:
        raise SystemExit(f'crop {frac} needs {bh:.0f}px of a {h}px capture')
    left = min(max(cx * w - bw / 2, 0), w - bw)
    top = min(max(cy * h - bh / 2, 0), h - bh)
    return (round(left), round(top), round(left + bw), round(top + bh))


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name, (src, frac, (out_w, out_h), quality) in JOBS.items():
        im = Image.open(os.path.join(RAW, src)).convert('RGB')
        if frac is None:
            crop = im
            out_h = out_h or round(im.height * out_w / im.width)
        else:
            crop = im.crop(crop_box(im.size, frac, out_w, out_h))
        if crop.width < out_w:
            raise SystemExit(f'{name}: the crop is {crop.width}px wide, less than the {out_w}px output')
        crop = crop.resize((out_w, out_h), Image.LANCZOS)
        path = os.path.join(OUT, f'{name}.webp')
        crop.save(path, 'WEBP', quality=quality, method=6)
        size = os.path.getsize(path)
        total += size
        print(f'{name}.webp  {out_w}x{out_h}  {size / 1024:.1f} KB')
    print(f'total {total / 1024:.1f} KB')


if __name__ == '__main__':
    main()
