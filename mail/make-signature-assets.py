#!/usr/bin/env python3
"""
Generate the signature's images: the icon chips and the QR code.

    python3 mail/make-signature-assets.py

Writes into frontend/public/images/sig/. Run it after changing the site URL,
the brand mark, or the icon set -- then deploy, because mail clients fetch
these over the public internet and an undeployed file is a broken box in
somebody's inbox.

DEPENDENCIES, and why one of them is unusual:

    qrencode                  apt
    Pillow                    pip
    opencv-python-headless    pip -- ONLY to verify, never to draw

The verification dependency is the whole point. A QR with a logo in the middle
is easy to produce and easy to get subtly wrong, and the failure mode is
invisible: it is the right shape, it looks like a QR code, and no phone will
read it. Two of the three designs tried here failed exactly that way. So
nothing is written until it has been decoded back, at every pixel size it
might actually render at.

opencv pulls numpy 2.x, which conflicts with an older scipy in the same
environment. Use a virtualenv if that matters:

    python3 -m venv /tmp/sigenv
    /tmp/sigenv/bin/pip install pillow opencv-python-headless
    /tmp/sigenv/bin/python mail/make-signature-assets.py
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.normpath(os.path.join(HERE, "..", "frontend", "public", "images"))
DEST = os.path.join(PUB, "sig")
LOGO = os.path.join(PUB, "apple-touch-icon.png")
URL = "https://circuitcenter.ai"

INK, PLATE, EDGE = (26, 31, 35), "#ffffff", "#dfe4e7"
INK_HEX = "#1a1f23"


# ---------------------------------------------------------------------------
# Icon chips
# ---------------------------------------------------------------------------
#
# Each glyph sits on an OPAQUE plate baked into the PNG. A bare monochrome
# glyph on transparency disappears the moment a client renders it on a dark
# background -- which is why the signature carried text labels for its whole
# first life. The plate carries its own ground, so an inverting client cannot
# erase it.
#
# Brand marks are the canonical simple-icons outlines; phone/email/website are
# Material's, chosen because they are FILLED like the brand marks. Mixing
# filled and stroked glyphs in one row reads as a mistake.

GLYPHS = {
    "phone": "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
    "email": "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
    "website": "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
    "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12z",
    "linkedin": "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
    "instagram": "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z",
    "x": "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
}

ICON_SIZE, ICON_SS = 96, 4  # 96px source for a 32px render


def build_icons(tmp):
    """Rasterise each chip. Returns [(name, bytes)]."""
    # ImageMagick's internal MSVG is the only renderer installed here. It draws
    # the geometry correctly but antialiases badly at target size, so everything
    # is supersampled and downsampled in Pillow instead.
    S = ICON_SIZE * ICON_SS
    inset = S * 0.30  # glyph occupies the middle 40%
    scale = (S - inset * 2) / 24
    out = []
    for name, path in GLYPHS.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
            f'viewBox="0 0 {S} {S}">'
            f'<rect x="{ICON_SS*1.5}" y="{ICON_SS*1.5}" width="{S-ICON_SS*3}" '
            f'height="{S-ICON_SS*3}" rx="{S*0.28}" fill="{PLATE}" stroke="{EDGE}" '
            f'stroke-width="{ICON_SS*2.2}"/>'
            f'<g transform="translate({inset},{inset}) scale({scale})">'
            f'<path d="{path}" fill="{INK_HEX}"/></g></svg>'
        )
        sp = os.path.join(tmp, f"{name}.svg")
        bp = os.path.join(tmp, f"{name}.png")
        with open(sp, "w") as fh:
            fh.write(svg)
        subprocess.run(["convert", "-background", "none", sp, bp], check=True)

        im = Image.open(bp).convert("RGBA")
        if im.size != (S, S):
            im = im.resize((S, S), Image.Resampling.LANCZOS)
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, (0, 0), im)
        flat = flat.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)

        dest = os.path.join(DEST, f"icon-{name}.png")
        flat.convert("P", palette=Image.Palette.ADAPTIVE, colors=64).save(dest, optimize=True)
        out.append((name, os.path.getsize(dest)))
    return out


# ---------------------------------------------------------------------------
# QR
# ---------------------------------------------------------------------------
#
# Two constraints here were found by decoding, not by looking.
#
# ISOLATED DOTS DO NOT DECODE. Drawing each dark module as a separate circle --
# the obvious way to get a soft, modern look -- failed at every size and every
# logo size, including one covering only 10% of the data. The gaps defeat the
# binarizer before error correction ever runs. Modules are therefore rounded
# but BRIDGED: orthogonally adjacent ones are joined by a bar, so each dark
# region stays a single connected shape.
#
# ROUNDED FINDER PATTERNS BREAK DETECTION. A scanner locates a code by its three
# corner patterns and their 1:1:3:1:1 scan-line ratio. Rounding those corners
# corrupts the ratio; the measured ceiling is 1.0 module of radius, above which
# nothing decodes at any size.

QUIET, SS = 4, 4
FINDER_R = 1.0  # module radii; measured ceiling, do not raise


def build_qr(tmp):
    import cv2
    import numpy as np

    raw_path = os.path.join(tmp, "qr-raw.png")
    subprocess.run(
        ["qrencode", "-l", "H", "-s", "1", "-m", "0", "-o", raw_path, URL], check=True
    )
    raw = Image.open(raw_path).convert("L")
    n = raw.size[0]
    M = [[int(raw.getpixel((x, y)) or 0) < 128 for x in range(n)] for y in range(n)]
    tot = n + QUIET * 2

    def is_finder(x, y):
        return (x < 7 and y < 7) or (x >= n - 7 and y < 7) or (x < 7 and y >= n - 7)

    def dark(x, y):
        return 0 <= x < n and 0 <= y < n and M[y][x] and not is_finder(x, y)

    def render(px, logo_ratio):
        unit = max(2, round(px * SS / tot))
        size = unit * tot
        img = Image.new("RGB", (size, size), "white")
        d = ImageDraw.Draw(img)
        off = QUIET * unit
        c0 = size / 2
        R = size * logo_ratio / 2
        moat = (R + unit) if logo_ratio > 0 else None

        for fx, fy in ((0, 0), (n - 7, 0), (0, n - 7)):
            X, Y = off + fx * unit, off + fy * unit
            d.rounded_rectangle([X, Y, X + 7 * unit, Y + 7 * unit],
                                radius=unit * FINDER_R, fill=INK)
            d.rounded_rectangle([X + unit, Y + unit, X + 6 * unit, Y + 6 * unit],
                                radius=unit * FINDER_R * 0.7, fill="white")
            d.rounded_rectangle([X + 2 * unit, Y + 2 * unit, X + 5 * unit, Y + 5 * unit],
                                radius=unit * FINDER_R * 0.45, fill=INK)

        def keep(x, y):
            if not dark(x, y):
                return False
            if moat is None:
                return True
            cx, cy = off + (x + .5) * unit, off + (y + .5) * unit
            return (cx - c0) ** 2 + (cy - c0) ** 2 >= moat ** 2

        r = unit * 0.5
        covered = 0
        for y in range(n):
            for x in range(n):
                if not dark(x, y):
                    continue
                if not keep(x, y):
                    covered += 1
                    continue
                cx, cy = off + (x + .5) * unit, off + (y + .5) * unit
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=INK)
                # Bridging right and down joins every adjacent pair exactly once.
                if keep(x + 1, y):
                    d.rectangle([cx, cy - r, cx + unit, cy + r], fill=INK)
                if keep(x, y + 1):
                    d.rectangle([cx - r, cy, cx + r, cy + unit], fill=INK)

        if logo_ratio > 0:
            d.ellipse([c0 - R - unit, c0 - R - unit, c0 + R + unit, c0 + R + unit],
                      fill="white")
            logo = Image.open(LOGO).convert("RGBA").resize((int(R * 2), int(R * 2)),
                                                           Image.Resampling.LANCZOS)
            mk = Image.new("L", (logo.width * 4, logo.height * 4), 0)
            ImageDraw.Draw(mk).ellipse((0, 0, mk.width - 1, mk.height - 1), fill=255)
            logo.putalpha(mk.resize(logo.size, Image.Resampling.LANCZOS))
            img.paste(logo, (int(c0 - R), int(c0 - R)), logo)

        return img.resize((px, px), Image.Resampling.LANCZOS), covered

    det = cv2.QRCodeDetector()

    def decodes(img):
        arr = np.array(img.convert("RGB"))[:, :, ::-1]
        try:
            value, _, _ = det.detectAndDecode(arr)
        except cv2.error:
            return False
        return value == URL

    total = sum(1 for y in range(n) for x in range(n) if dark(x, y))
    print(f"  matrix {n}x{n}, ECC=H, {total} data modules")

    chosen = None
    for ratio in (0.30, 0.28, 0.26, 0.24, 0.22, 0.20):
        img, covered = render(1200, ratio)
        if not decodes(img):
            print(f"    logo {int(ratio*100):>2}%  fails")
            continue
        floors = [s for s in (600, 400, 300, 240, 200, 176, 160, 144, 128, 112, 96)
                  if decodes(render(s, ratio)[0])]
        if floors and min(floors) <= 176:
            chosen = (ratio, min(floors), covered, total)
            break

    if chosen is None:
        sys.exit("    no logo size decoded -- refusing to write an unscannable code")

    ratio, floor, covered, total = chosen
    # 480px source for a 112px render. Palette-quantised: the image is two
    # colours plus the badge, so RGB spends ~3x the bytes for no visible gain.
    img, _ = render(480, ratio)
    dest = os.path.join(DEST, "qr-circuitcenter.png")
    img.convert("P", palette=Image.Palette.ADAPTIVE, colors=64).save(dest, optimize=True)

    if not decodes(Image.open(dest)):
        sys.exit("    written file does not decode -- quantisation broke it")

    print(f"    logo {int(ratio*100)}%: covers {covered}/{total} modules "
          f"({100*covered/total:.1f}%), decodes at >= {floor}px")
    print(f"    qr-circuitcenter.png  {os.path.getsize(dest):,}B  "
          f"(set qr_size >= {floor} in the roster)")


def main():
    import tempfile

    os.makedirs(DEST, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        print("icons:")
        for name, size in build_icons(tmp):
            print(f"    icon-{name}.png  {size:,}B")
        print("qr:")
        build_qr(tmp)
    print(f"\nwrote {DEST} -- deploy before the roster URLs resolve")


if __name__ == "__main__":
    main()
