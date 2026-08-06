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
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.normpath(os.path.join(HERE, "..", "frontend", "public", "images"))
DEST = os.path.join(PUB, "sig")
LOGO = os.path.join(PUB, "apple-touch-icon.png")
URL = "https://circuitcenter.ai"

INK, PLATE, EDGE = (26, 31, 35), "#ffffff", "#dfe4e7"
INK_HEX = "#1a1f23"

# The QR's ground. It must match whatever surface the code is placed on in
# signature-template.php -- currently SIG_PILL_BG, the tinted panel inside the
# white card. Keep the two in step: a mismatch is not subtle, it draws a hard
# rectangle around the code. Contrast is unaffected either way -- ink on this is
# about 15:1, far above anything a scanner needs.
QR_BG = "#f4f7f6"


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

# Bare glyphs, for use INSIDE the contact pills.
#
# A plated chip dropped into a pill reads as a chip inside a pill -- two
# containers where the design has one. So these carry no plate, and they solve
# the dark-mode problem a different way: they are drawn in SIG_SPINE, the value
# signature-template.php already picked for the vertical rule because it clears
# 3:1 as non-text content against BOTH ends of the range (4.35:1 on white,
# 3.70:1 on a dark surface). A client that inverts the pill's background cannot
# erase them, which is the same guarantee the plate gives the social chips by
# a different route.
GLYPH_SIZE, GLYPH_SS = 48, 4  # 48px source for a 16px render
SPINE_HEX = "#2e8b1a"
PILL_GLYPHS = ("phone", "email", "website")


# The plateless social glyphs and the pill icon discs.
#
# The reference puts its social marks on the white card as BARE glyphs, and
# that is safe there for the same reason a plated chip was safe standing alone:
# the card declares its own white ground, so an inverting client flips card and
# glyph together. The plate only ever existed to supply a ground that was
# missing.
#
# The pill icons keep a ground, but as a tinted DISC rather than a rounded
# plate -- a circle inside a capsule reads as one component where a square
# inside a capsule reads as two.
SOCIAL_SIZE = 60           # 60px source for a 20px render
BADGE_SIZE, BADGE_SS = 88, 4   # 88px source for a 22px render
BADGE_DISC = "#e4f0e0"     # SIG_SPINE washed down onto white
BADGE_GLYPHS = ("phone", "email", "website")
BRANDS_JSON = os.path.join(HERE, "signature-brand-icons.json")


# The backdrop.
#
# V13's ground is a lavender wash, #f3f1ff flat warming to #deccfb toward the
# top right. Those are its brand hues, not ours, so the RELATIONSHIP carries
# over rather than the colours -- the same lightness and corner warming,
# rotated onto the green this project already uses.
#
# Shipped as a PNG because CSS gradients do not render in Outlook, which uses
# Word's engine. The template pairs it with a flat bgcolor, so Outlook gets the
# tint and everyone else the wash. Sized to the signature and never tiled:
# background-size is not reliable in email either.
BACKDROP_W, BACKDROP_H = 600, 360
BACKDROP_BASE = (243, 248, 242)   # very light green-cast, V13's #f3f1ff rotated
BACKDROP_WARM = (203, 229, 202)   # the corner wash, V13's #deccfb rotated


# ---------------------------------------------------------------------------
# Rasterisation
# ---------------------------------------------------------------------------
#
# Through headless Chrome, not ImageMagick.
#
# `convert` here has only the internal MSVG renderer -- no rsvg, inkscape or
# sharp delegate -- and MSVG is not a conforming SVG parser. It rejects path
# data that is perfectly valid, dying on a relative lineto written `l3.263-.582`
# with "non-conforming drawing primitive definition". Several of the brand marks
# fail exactly that way, so this is a correctness fix and not a preference. It
# also antialiases badly at target size, which is why the earlier icons were
# supersampled 4x to compensate.
#
# Chrome is what the shipped favicons were rasterised with, for the same
# reasons. Everything is laid out on ONE page and captured in ONE invocation
# then sliced: 50-odd separate Chrome launches would dominate the runtime.
CHROME = "google-chrome"
RASTER_COLS = 8


def rasterize(items, cell, tmp, tag):
    """items: [(name, svg_markup)] -> {name: RGBA Image, `cell` px square}.

    Each glyph is drawn into its own cell-sized box on a grid, so slicing is
    arithmetic rather than detection.
    """
    if not items:
        return {}
    cols = min(RASTER_COLS, len(items))
    rows = (len(items) + cols - 1) // cols
    w, h = cols * cell, rows * cell

    boxes = []
    for i, (_, markup) in enumerate(items):
        x, y = (i % cols) * cell, (i // cols) * cell
        boxes.append(
            f'<div style="position:absolute;left:{x}px;top:{y}px;'
            f'width:{cell}px;height:{cell}px">{markup}</div>'
        )
    page = os.path.join(tmp, f"sheet-{tag}.html")
    shot = os.path.join(tmp, f"sheet-{tag}.png")
    with open(page, "w") as fh:
        fh.write(
            "<!doctype html><meta charset=utf-8>"
            f'<body style="margin:0;background:transparent;width:{w}px;height:{h}px">'
            + "".join(boxes) + "</body>"
        )

    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         "--default-background-color=00000000", f"--window-size={w},{h}",
         f"--screenshot={shot}", "file://" + page],
        check=True, capture_output=True,
    )

    sheet = Image.open(shot).convert("RGBA")
    if sheet.size != (w, h):
        # A mismatch would silently slice the wrong pixels, so it is an error
        # rather than something to resize around.
        raise RuntimeError(f"{tag}: expected a {w}x{h} sheet, got {sheet.size}")

    return {name: sheet.crop(((i % cols) * cell, (i // cols) * cell,
                              (i % cols) * cell + cell, (i // cols) * cell + cell))
            for i, (name, _) in enumerate(items)}


def social_slug(label):
    """Label -> filename key. MUST match sig_social_slug() in the template.

    Lowercase, then drop anything that is not a letter or digit. Deliberately
    NOT simple-icons' own slug field: for "dev.to" theirs is "devdotto" and this
    gives "devto". One rule applied to the title beats importing a second
    identifier that agrees 49 times in 50.
    """
    return re.sub(r"[^a-z0-9]+", "", label.lower())


def brand_paths():
    """Every social glyph to generate: the curated brand set, plus LinkedIn.

    Brand paths come from signature-brand-icons.json, extracted once from
    simple-icons rather than typed from memory -- a subtly wrong path renders a
    subtly wrong logo, which is worse than no logo.

    LinkedIn is carried in GLYPHS instead because it was REMOVED from
    simple-icons at the brand owner's request; this path predates that file and
    is verified visually. Slack, Skype, CodePen and AngelList were removed the
    same way and are deliberately NOT reinstated -- a label with no icon file
    renders as a text link, which the template already supports.
    """
    with open(BRANDS_JSON) as fh:
        data = json.load(fh)
    out = {social_slug(title): v["path"] for title, v in data["icons"].items()}
    out["linkedin"] = GLYPHS["linkedin"]
    return out


def build_icons(tmp):
    """Plated chips. Returns [(name, bytes)]."""
    S = ICON_SIZE * ICON_SS
    inset = S * 0.30  # glyph occupies the middle 40%
    scale = (S - inset * 2) / 24
    items = [(name, (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
        f'viewBox="0 0 {S} {S}">'
        f'<rect x="{ICON_SS*1.5}" y="{ICON_SS*1.5}" width="{S-ICON_SS*3}" '
        f'height="{S-ICON_SS*3}" rx="{S*0.28}" fill="{PLATE}" stroke="{EDGE}" '
        f'stroke-width="{ICON_SS*2.2}"/>'
        f'<g transform="translate({inset},{inset}) scale({scale})">'
        f'<path d="{path}" fill="{INK_HEX}"/></g></svg>'
    )) for name, path in GLYPHS.items()]

    out = []
    for name, im in rasterize(items, S, tmp, "icons").items():
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, (0, 0), im)
        flat = flat.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
        dest = os.path.join(DEST, f"icon-{name}.png")
        flat.convert("P", palette=Image.Palette.ADAPTIVE, colors=64).save(dest, optimize=True)
        out.append((name, os.path.getsize(dest)))
    return sorted(out)

def build_backdrop():
    from math import hypot
    w, h = BACKDROP_W, BACKDROP_H
    img = Image.new("RGB", (w, h), BACKDROP_BASE)
    px = img.load()
    # Radial falloff anchored off the top-right corner, matching where the
    # reference's wash sits.
    cx, cy = w * 0.78, h * -0.05
    far = hypot(w, h) * 0.72
    for y in range(h):
        for x in range(w):
            t = max(0.0, 1.0 - hypot(x - cx, y - cy) / far) ** 1.6
            px[x, y] = tuple(
                int(BACKDROP_BASE[i] + (BACKDROP_WARM[i] - BACKDROP_BASE[i]) * t)
                for i in range(3)
            )
    dest = os.path.join(DEST, "backdrop.png")
    img.convert("P", palette=Image.Palette.ADAPTIVE, colors=64).save(dest, optimize=True)
    return os.path.getsize(dest)


def build_socials(tmp):
    """Bare ink glyphs, for the white card. Returns [(name, bytes)]."""
    S = SOCIAL_SIZE * GLYPH_SS
    items = [(name, (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
        f'viewBox="0 0 24 24"><path d="{path}" fill="{INK_HEX}"/></svg>'
    )) for name, path in sorted(brand_paths().items())]

    out = []
    for name, im in rasterize(items, S, tmp, "socials").items():
        im = im.resize((SOCIAL_SIZE, SOCIAL_SIZE), Image.Resampling.LANCZOS)
        dest = os.path.join(DEST, f"social-{name}.png")
        im.save(dest, optimize=True)
        out.append((name, os.path.getsize(dest)))

    # Write the manifest the TEMPLATE needs to know which icons exist.
    #
    # sig_social builds a URL on another host, so it cannot stat the file --
    # it validated the slug's GRAMMAR and emitted an <img> regardless. A label
    # with no icon therefore produced a broken image in the recipient's inbox
    # rather than the text link the design promised. Harmless while the roster
    # held three known names; a guarantee once anyone can type a label.
    #
    # Generated here rather than hand-listed, so the list cannot drift from the
    # files: this function is the only thing that creates them.
    slugs = sorted(n for n, _ in out)
    manifest = os.path.join(HERE, "signature-icon-slugs.php")
    with open(manifest, "w") as fh:
        fh.write("<?php\n")
        fh.write("/**\n")
        fh.write(" * GENERATED by mail/make-signature-assets.py -- do not edit.\n")
        fh.write(" *\n")
        fh.write(" * Every social mark that exists on disk. signature-roster.php feeds this\n")
        fh.write(" * to the company block as 'icon_slugs', and sig_social_row will only emit\n")
        fh.write(" * an <img> for a slug in here; everything else renders as a text link.\n")
        fh.write(" *\n")
        fh.write(" * The template cannot check this itself. It builds a URL on a different\n")
        fh.write(" * host, so it has no file to stat, and it must stay a pure function.\n")
        fh.write(" * Guarded by test_template.php, which asserts this list equals the\n")
        fh.write(" * social-*.png files actually present.\n")
        fh.write(" */\n")
        fh.write("return [\n")
        for sl in slugs:
            fh.write(f"    '{sl}',\n")
        fh.write("];\n")
    print(f"    signature-icon-slugs.php  {len(slugs)} slugs")
    return sorted(out)

def build_badges(tmp):
    """Tinted disc with a spine-green glyph, for inside the pills."""
    S = BADGE_SIZE * BADGE_SS
    inset = S * 0.27
    scale = (S - inset * 2) / 24
    items = [(name, (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
        f'viewBox="0 0 {S} {S}">'
        f'<circle cx="{S/2}" cy="{S/2}" r="{S/2}" fill="{BADGE_DISC}"/>'
        f'<g transform="translate({inset},{inset}) scale({scale})">'
        f'<path d="{GLYPHS[name]}" fill="{SPINE_HEX}"/></g></svg>'
    )) for name in BADGE_GLYPHS]

    out = []
    for name, im in rasterize(items, S, tmp, "badges").items():
        im = im.resize((BADGE_SIZE, BADGE_SIZE), Image.Resampling.LANCZOS)
        dest = os.path.join(DEST, f"badge-{name}.png")
        im.save(dest, optimize=True)
        out.append((name, os.path.getsize(dest)))
    return sorted(out)

def build_glyphs(tmp):
    """Plateless glyphs in the spine green. Returns [(name, bytes)]."""
    S = GLYPH_SIZE * GLYPH_SS
    scale = S / 24
    items = [(name, (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
        f'viewBox="0 0 {S} {S}"><g transform="scale({scale})">'
        f'<path d="{GLYPHS[name]}" fill="{SPINE_HEX}"/></g></svg>'
    )) for name in PILL_GLYPHS]

    out = []
    for name, im in rasterize(items, S, tmp, "glyphs").items():
        im = im.resize((GLYPH_SIZE, GLYPH_SIZE), Image.Resampling.LANCZOS)
        # RGBA rather than palette-quantised: the alpha edge is the whole point
        # of a plateless glyph, and 64 colours bands it visibly at 16px against
        # a tinted pill.
        dest = os.path.join(DEST, f"glyph-{name}.png")
        im.save(dest, optimize=True)
        out.append((name, os.path.getsize(dest)))
    return sorted(out)

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

# QUIET is 2 modules, not the spec's 4, and the difference is made up by the
# tinted panel the template places the code on -- that padding is the same
# colour as the code's ground, so a scanner reads one continuous quiet zone
# across the join.
#
# It matters because the quiet zone is baked into the image and therefore eats
# the display size: at 4 modules the border is 22% of the file, so a 184px
# render put only 144px of actual code on screen -- about 5px per module, which
# is where decoding starts failing. At 2 modules the same 184px carries 162px
# of code. Fewer wasted pixels AND a smaller tinted margin, which is the shape
# this design wanted anyway.
# The size the TEMPLATE renders this at; the shipped file is 3x it for
# resolution. Chosen by measuring browser-rendered decodes rather than by
# theory -- see the note in build_qr. Keep in step with 'qr_size' in
# signature-roster.php.
DISPLAY_PX = 180

QUIET, SS = 2, 4
FINDER_R = 1.0  # module radii; measured ceiling, do not raise


def _has_brand_green(rgb, threshold=200):
    """Is the logo's green still present? Guards the quantisation step."""
    hits = 0
    for r, g, b in rgb.getdata():
        if g > 60 and g > r + 25 and g > b + 25:
            hits += 1
            if hits >= threshold:
                return True
    return False


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
        img = Image.new("RGB", (size, size), QR_BG)
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
                                radius=unit * FINDER_R * 0.7, fill=QR_BG)
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
                      fill=QR_BG)
            # Saturation is boosted AFTER the resize, not before, and that
            # order is the whole trick. The badge renders around 119px, where
            # the mark's green strokes are only a few pixels wide; downscaling
            # averages each one against the dark plate behind it, so the green
            # survives as a muddy olive and the thinnest stroke -- the
            # capacitor's lead -- reads as black. Re-saturating the already
            # blended pixels pulls that chroma back. Boosting first would just
            # feed brighter values into the same averaging.
            logo = Image.open(LOGO).convert("RGBA").resize((int(R * 2), int(R * 2)),
                                                           Image.Resampling.LANCZOS)
            rgb_part, alpha = logo.convert("RGB"), logo.getchannel("A")
            rgb_part = ImageEnhance.Color(rgb_part).enhance(1.7)
            logo = rgb_part.convert("RGBA")
            logo.putalpha(alpha)
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

    # Candidates START at 0.22, not at the largest badge that happens to pass.
    #
    # Decoding is erratic in a way that is not the code degrading: the same
    # image reads at 330px, fails at 440px, and reads again at 640px. That is
    # this detector, and a real phone camera is both more capable and working
    # under worse conditions -- angle, glare, a screen refreshing under it. So
    # the badge is deliberately smaller than the biggest one that passes,
    # trading decoration for error-correction headroom. 0.26 passed and is not
    # used; 0.22 covers 12.1% of data modules instead of 16.2%.
    chosen = None
    for ratio in (0.22, 0.20, 0.18):
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
    # Source at 3x the render size, for resolution on a 2x screen. The ratio
    # itself buys nothing -- that was tested and is worth recording so nobody
    # re-derives it.
    #
    # Decoding a BROWSER-RENDERED code is erratic with respect to display size
    # in a way that has no threshold to find. From a 640px source it read at
    # 180px, failed at 190 through 210, read again at 220 and 230. The obvious
    # theory was that an integer downscale ratio would land module edges on
    # whole pixels, so the source was pinned to exactly 3x -- and at exactly
    # 3.00x it FAILED, while 3.25x and 2.66x read. The theory is wrong.
    #
    # What this actually is: OpenCV's detector binarizing badly at particular
    # module-to-pixel ratios. The code is fine, and the proof is that the same
    # failing render decodes perfectly when upscaled 3x with nearest-neighbour
    # -- the geometry and the data are intact, the reader is not.
    #
    # So DISPLAY_PX is chosen EMPIRICALLY: 180 is the one size that decoded in
    # both independent sweeps. Treat that as a weak signal, not a guarantee.
    # A phone camera is a far better reader than this and works from a
    # high-resolution capture rather than a fixed downscale, so it is more
    # capable than anything measured here -- but it has to be tested on a real
    # device, because nothing available in this environment can stand in for
    # it.
    img, _ = render(DISPLAY_PX * 3, ratio)
    dest = os.path.join(DEST, "qr-circuitcenter.png")

    # Quantise only if the BADGE SURVIVES it.
    #
    # An adaptive palette allocates its slots by frequency, and this image is
    # overwhelmingly two colours. The brand green in the centre badge is a
    # fraction of a percent of the pixels, so a 64-colour palette spent every
    # slot on ink, ground and antialiasing and dropped the green entirely --
    # the capacitor came out grey and nothing failed, because a quantiser has
    # no opinion about which colours matter.
    #
    # So the property is checked rather than assumed: quantise, look for the
    # green, and fall back to RGB if it is gone. Costs bytes only when it has
    # to, and cannot silently regress.
    best = None
    for colours in (64, 128, 256):
        cand = img.convert("P", palette=Image.Palette.ADAPTIVE, colors=colours)
        if _has_brand_green(cand.convert("RGB")):
            best = (cand, f"{colours}-colour palette")
            break
    if best is None:
        best = (img, "RGB (palette dropped the badge green)")
    best[0].save(dest, optimize=True)

    written = Image.open(dest)
    if not _has_brand_green(written.convert("RGB")):
        sys.exit("    written file lost the badge green")
    if not decodes(written):
        sys.exit("    written file does not decode -- encoding broke it")
    print(f"    badge green preserved via {best[1]}")

    print(f"    logo {int(ratio*100)}%: covers {covered}/{total} modules "
          f"({100*covered/total:.1f}%), decodes at >= {floor}px")
    print(f"    qr-circuitcenter.png  {os.path.getsize(dest):,}B  "
          f"(render at EXACTLY {DISPLAY_PX}px; floor {floor}px)")


def main():
    import tempfile

    os.makedirs(DEST, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        print("icons (plated, for the social chips):")
        for name, size in build_icons(tmp):
            print(f"    icon-{name}.png  {size:,}B")
        print("glyphs (plateless):")
        for name, size in build_glyphs(tmp):
            print(f"    glyph-{name}.png  {size:,}B")
        print("badges (tinted disc, for inside the contact pills):")
        for name, size in build_badges(tmp):
            print(f"    badge-{name}.png  {size:,}B")
        print("socials (bare ink, for the white card):")
        for name, size in build_socials(tmp):
            print(f"    social-{name}.png  {size:,}B")
        print("backdrop:")
        print(f"    backdrop.png  {build_backdrop():,}B")
        print("qr:")
        build_qr(tmp)
    print(f"\nwrote {DEST} -- deploy before the roster URLs resolve")


if __name__ == "__main__":
    main()
