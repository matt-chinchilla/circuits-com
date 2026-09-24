"""Turn the raw captures from capture.playwright.js into the guide's WebP files.

Every crop is a FRACTION of the captured element's own box (the stage, the
drawer, the viewport), never a pixel position, so a re-capture at another
window size lands on the same content. Output sizes are twice the largest size
each picture is drawn at, so they stay sharp on a 2x screen.

    python3 frontend/scripts/viewer-guide/encode.py [RAW_DIR]

Needs Pillow built with WebP (python3 -c "from PIL import features; print(features.check('webp'))").
"""
import os
import sys

from PIL import Image

RAW = sys.argv[1] if len(sys.argv) > 1 else '/tmp/viewer-guide-raw'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'viewer-guide')

# name: (source, (left, top, right, bottom) as fractions, output width, quality)
JOBS = {
    'schematic': ('sch-stage.png', (0.02, 0.06, 0.98, 0.9), 360, 78),
    'schematic-u30': ('sch-u30-stage.png', (0.12, 0.04, 0.88, 0.64), 560, 74),
    'board-u30': ('board-u30-stage.png', (0.0, 0.0, 1.0, 0.9), 600, 72),
    'stackup': ('stackup-stage.png', (0.01, 0.0, 0.76, 0.42), 360, 80),
    'board-3d-u30': ('3d-stage.png', (0.12, 0.1, 0.88, 0.8), 820, 74),
    'bom': ('bom-viewport.png', (0.14, 0.38, 0.75, 0.92), 420, 80),
    'part-panel-u30': ('panel-drawer.png', (0.0, 0.13, 1.0, 0.9), 560, 82),
}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name, (src, (l, t, r, b), width, quality) in JOBS.items():
        im = Image.open(os.path.join(RAW, src)).convert('RGB')
        w, h = im.size
        crop = im.crop((round(l * w), round(t * h), round(r * w), round(b * h)))
        height = round(crop.height * width / crop.width)
        crop = crop.resize((width, height), Image.LANCZOS)
        path = os.path.join(OUT, f'{name}.webp')
        crop.save(path, 'WEBP', quality=quality, method=6)
        size = os.path.getsize(path)
        total += size
        print(f'{name}.webp  {width}x{height}  {size / 1024:.1f} KB')
    print(f'total {total / 1024:.1f} KB')


if __name__ == '__main__':
    main()
