# Circuit Center — Roundcube skin

Liquid-glass panes over a solder-mask bench: a "cyberpunk-iOS" skin for
Roundcube 1.6, derived from Elastic. Design rationale, palette, the
adopt/adapt/skip ledger against the owner's glass system, and all measured
contrast ratios are in [DESIGN.md](DESIGN.md).

```
circuitcenter/
├── meta.json                        skin manifest ("extends": "elastic")
├── templates/includes/layout.html   the ONE template override
├── styles/circuitcenter.css         the whole skin
├── images/logo.svg                  wordmark (shadows Elastic's stock cube)
├── watermark.html                   empty reading pane
├── thumbnail.png                    Settings > Interface preview
├── DESIGN.md
└── README.md
```

Nothing here is generated and there is no build step — `circuitcenter.css` is
hand-written plain CSS. No LESS, no npm, no compile.

---

## How it works

The skin **extends Elastic** rather than replacing it. `meta.json` declares
`"extends": "elastic"`, so Roundcube keeps Elastic in its skin-path stack and
resolves any file we do not ship from there — every template, every icon, the
Font Awesome fonts, `ui.js`, all of it.

It rides Elastic's **light** theme: Elastic's default styles are the base,
and `styles/circuitcenter.css` loads after them and re-materialises the
chrome — the working columns become glass panes over a dark bench, the task
rail becomes bare board. Elastic's dark stylesheet is never engaged
(`dark_mode_support: false`; the Settings light/dark toggle is hidden).

`<html>` carries `cc` (set in `templates/includes/layout.html` as a class
attribute, so there is no unstyled flash). Every rule in `circuitcenter.css`
is written `html.cc …`, which out-specifies Elastic's mostly classless-root
light rules — and where a selector is mirrored exactly, load order decides.
`cc` is ours and Roundcube's `ui.js` never touches it, so the layer cannot be
stripped out from under us.

### The one non-obvious thing

Upstream's `layout.html` links `/styles/styles.css`, **a file that exists in
no Roundcube distribution** — releases ship `styles.min.css` only. Elastic
gets away with it because `rcmail_output_html::file_mod()` silently rewrites
a missing `.css` to `.min.css`, and it does that lookup relative to
`$base_path`, which is "whichever skin the template was found in". The moment
this skin overrides `layout.html`, `$base_path` becomes `skins/circuitcenter`,
the `.min` swap looks in the wrong directory, and Elastic's entire stylesheet
404s.

So our copy names the minified files explicitly. If you ever run against a
build that has an unminified `styles.css` and no `styles.min.css`, drop the
two `.min` in `templates/includes/layout.html`.

---

## Install

`ROUNDCUBE_ROOT` is wherever Roundcube lives — `/var/www/html` in the official
`roundcube/roundcubemail` image, `/usr/share/roundcube` on Debian packages.

```bash
ROUNDCUBE_ROOT=/var/www/html

# 1. copy the skin in, next to elastic
cp -r mail/roundcube-skin/circuitcenter "$ROUNDCUBE_ROOT/skins/circuitcenter"

# 2. make it the default (config/config.inc.php)
#      $config['skin'] = 'circuitcenter';
#    if you have restricted the list, circuitcenter must be in it:
#      $config['skins_allowed'] = ['circuitcenter', 'elastic'];
```

In a container, mount it read-only instead of copying so it survives image
updates:

```yaml
volumes:
  - ./mail/roundcube-skin/circuitcenter:/var/www/html/skins/circuitcenter:ro
```

No restart is needed for CSS edits — Roundcube appends an mtime cache-buster
to every skin asset. Changing `config.inc.php` does need the container
restarting.

## Verify after install

```bash
# 1. Elastic's stylesheet resolves (the failure mode described above).
#    Expect 200. A 404 here means an unminified build: see "the one
#    non-obvious thing".
curl -sI https://mail.circuitcenter.ai/skins/elastic/styles/styles.min.css \
  | head -1

# 2. Our sheet resolves. Expect 200.
curl -sI https://mail.circuitcenter.ai/skins/circuitcenter/styles/circuitcenter.css \
  | head -1

# 3. No animation loop, no compositor traps, no external fetches.
#    Expect matches in COMMENT lines only (the sheet documents its own
#    bans). The inline SVG data-URIs' xmlns is a namespace identifier, not
#    a URL that is fetched — url(https?:...) is what would indicate a real
#    external asset.
grep -nE '@keyframes|animation:|@import|url\(https?:|will-change|mix-blend|hue-rotate' \
  "$ROUNDCUBE_ROOT/skins/circuitcenter/styles/circuitcenter.css"
```

Then open the webmail and check, on a desktop width:

- the three columns float as rounded glass panes with the dark green bench
  visible in the 10px gaps between them;
- the bench is a SMOOTH gradient under a faint grid — if it renders as
  bevelled 24px bricks, a `background-size` list is short one layer (the
  grid var expands to two layers; the gradient is the third);
- the task rail at the far left is dark bare board with gold contact fingers,
  the active task's finger lit;
- panel titles read `U1 · FOLDERS` / `U2 · INBOX` in gold monospace
  silkscreen;
- unread rows carry a deep-gold LED with a soft halo; the selected row is a
  gold tint, not a filled bar;
- exactly one gold "pad" button per screen (Send / Save); Delete is quiet red
  text;
- the login screen is the Circuit Center IC wordmark and a single glass card
  on the OPEN bench (the pane veil is carved out of `#layout-content` on
  `body.task-login` — if the whole page is a white sheet, that carve-out
  regressed), plated drill-holes in the card corners, a small `CN1` mark;
- the empty reading pane shows the board coupon with `U3`.

Verified against the live install (2026-07-31, Roundcube 1.6.x): both
stylesheets 200; served CSS byte-identical to the repo; login page rendered
correctly at 1440px and at phone width (opaque card, zero backdrop-filter,
bench visible) after the carve-out and background-size fixes; the
`!important` audit below produced the seven mirrors in section 11 of the
stylesheet. Still unverified (needs a logged-in session): message-list /
reading-pane / compose rendering, and the iframe-opacity check.

And two health checks worth 60 seconds:

- **iframe surfaces**: open a message — the preview document's background
  must be opaque porcelain (`#f2f5f3`), never transparent (glass cannot
  composite across an iframe boundary);
- **mobile**: below 768px everything goes edge-to-edge and opaque and
  `backdrop-filter` is gone (DevTools device mode is enough to confirm).

## Upgrading Roundcube

Two things to re-check, both cheap.

**1. `layout.html` drift.** Our copy is upstream's file with three marked
changes plus one forced correction (all listed at the top of the file).
Diff it:

```bash
diff -u "$ROUNDCUBE_ROOT/skins/elastic/templates/includes/layout.html" \
        "$ROUNDCUBE_ROOT/skins/circuitcenter/templates/includes/layout.html"
```

Anything beyond those changes is new upstream work to port in.

**2. Specificity fights.** Riding the light theme means Elastic's base rules
are low-specificity and `html.cc` mirrors out-rank nearly everything — but a
handful of upstream rules carry their own `:not()` guards or `!important`
(section 11 of `circuitcenter.css` holds the current mirrors, each verified
against the served compiled sheet). After an upgrade, re-run both audits:

```bash
# !important declarations touching properties this skin sets
grep -oE '[^}{]{0,80}![[:space:]]*important[^;}]{0,10}' \
  "$ROUNDCUBE_ROOT/skins/elastic/styles/styles.min.css" \
  | grep -iE 'background|color|border|shadow|font' | sort -u

# :not() guards (each adds a class's worth of specificity)
grep -oE '(html)?[^,{]*:not\([^,{]*' \
  "$ROUNDCUBE_ROOT/skins/elastic/styles/styles.min.css" | sort -u | head -50
```

Anything in either list touching a property this skin sets needs a mirror in
section 11.

## Constraints this skin holds to

- **No perpetual animation** — no `@keyframes`, no `animation`, no
  `requestAnimationFrame`, no `<canvas>`. Hover/focus transitions only, and
  `prefers-reduced-motion` neutralises those.
- **No compositor traps** — no `will-change`, no `mix-blend-mode`, no
  `hue-rotate`, no pointer-driven CSS variables. `backdrop-filter` is static,
  declared prefixed + unprefixed, and dropped entirely ≤768px where surfaces
  go opaque instead.
- **Offline-safe** — no CDN, no webfont, no remote image, no `@import`. Type
  is the OS-native stack; icons stay Elastic's self-hosted Font Awesome; the
  only `url()`s are inline SVG data-URIs.
- **Contrast** — body text ≥ 4.5:1, non-text UI ≥ 3:1, computed against the
  worst-case composited glass surface (which equals the no-backdrop-filter
  fallback). Global minimum 4.91:1. Full table in DESIGN.md. Not yet
  re-verified against a rendered install — the mail stack isn't deployed;
  run the checks above when it lands.
- **Density untouched** — no row height, padding or breakpoint of Elastic's
  is changed; the bench gaps and pane radii live outside the working
  surfaces.

## Not included, on purpose

- **`styles/embed.css`** — inherited from Elastic, which keeps HTML mail
  bodies and the compose editor on white. Sender-styled HTML forced into a
  themed palette is how webmail clients wreck newsletters; the white sheet is
  mounted (rounded, hairlined, shadowed) instead of recoloured.
- **A dark mode toggle** — the skin is already both: dark bench outside the
  glass, light surfaces inside it. One theme means one audited contrast set.
  Printing hands the page back to ink-on-white (section 13).
- **The donor system's cursor-tracked rim/gloss JS** — deliberately not
  ported; see DESIGN.md's adopted/adapted/skipped ledger.
- **A `$config['skin_logo']` entry** — not needed: the skin ships
  `images/logo.svg` (the IC wordmark), which shadows Elastic's stock cube via
  skin-path resolution. Setting `skin_logo` still overrides it if a customer
  ever wants to.
