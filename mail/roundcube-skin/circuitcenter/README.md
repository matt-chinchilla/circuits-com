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
├── images/logo.svg                  login wordmark (needs a skin_logo line)
├── images/logo-badge.svg            in-app rail badge (needs a skin_logo line)
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

# 3. REQUIRED for BOTH logos (config/config.inc.php):
#      $config['skin_logo'] = [
#          'circuitcenter:login' => 'skins/circuitcenter/images/logo.svg',
#          'circuitcenter:*'     => 'skins/circuitcenter/images/logo-badge.svg',
#      ];
#    Without these lines Roundcube's stock 3D cube renders. Why file
#    placement alone cannot replace it: the logo tag lives in ELASTIC's
#    templates (login.html and includes/menu.html), and
#    rcmail_output_html::file_callback resolves its "/images/logo.svg" src
#    with the template's own skin (elastic) unshifted to the FRONT of the
#    skin search (get_skin_file $add_path, release-1.6) — elastic ships
#    that file, so it always wins. The config values must stay
#    webroot-relative with NO leading slash: file_callback re-anchors
#    leading-slash paths into that same elastic-first search, while a
#    non-slash path passes through untouched (plus cache-buster).
```

Two keys, because there are two logo slots and they are different shapes.
`login` is the 232x56 lockup on the sign-in screen. The wildcard covers the
**in-app** slot at the top of the task rail, which gets the square badge
(`logo-badge.svg` — its own header explains the size ladder and why the
lockup cannot serve there).

The in-app slot needs a wildcard rather than a named template because its tag
lives in `templates/includes/menu.html`, an **include**: `rcmail_output_html`
sets `template_name` for the top-level template only, so the logo object
reports the enclosing *task* template (`mail`, `addressbook`, `settings`, …),
never `menu`. Enumerating tasks would silently miss any we forgot.

Order is safe. `get_template_logo()` tries `skin:template` before `skin:*`
(release-1.6), so login keeps the lockup. Typed lookups — favicon, print,
link — only ever match bracket-suffixed keys (`[favicon]`), and the print
templates additionally pass `logo-match="template"`, which strips wildcard
keys from the candidate list; neither key can leak into them.

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

# 3. Both logos resolve. Expect 200 + image/svg+xml on each.
curl -sI https://mail.circuitcenter.ai/skins/circuitcenter/images/logo.svg \
  | grep -iE '^HTTP|^content-type'
curl -sI https://mail.circuitcenter.ai/skins/circuitcenter/images/logo-badge.svg \
  | grep -iE '^HTTP|^content-type'
#    Serving is only half of it: the in-app badge also needs the wildcard
#    skin_logo key above to be ACTIVE. Confirm on a logged-in page that the
#    rail's top-left image is skins/circuitcenter/..., not skins/elastic/...:
#      view-source, or DevTools, and read the #logo src.

# 4. No animation loop, no compositor traps, no external fetches.
#    Expect matches in COMMENT lines only (the sheet documents its own
#    bans). The inline SVG data-URIs' xmlns is a namespace identifier, not
#    a URL that is fetched — url(https?:...) is what would indicate a real
#    external asset.
grep -nE '@keyframes|animation:|@import|url\(https?:|will-change|mix-blend|hue-rotate' \
  "$ROUNDCUBE_ROOT/skins/circuitcenter/styles/circuitcenter.css"
```

### The owner's walkthrough (no tools needed — just eyes)

Anyone with a mailbox can run this in five minutes. For each step: do the
thing, compare with what SHOULD happen, and if it doesn't match, report the
step number plus a screenshot (on a Mac: Cmd+Shift+3; on Windows:
Win+Shift+S). Use a normal desktop browser window, maximized.

1. **Open https://mail.circuitcenter.ai — before logging in.**
   Should be: a dark green board fading into shadow with a very faint grid,
   ONE pale card floating in the middle, tiny gold dots in the card's
   corners, "CN1" in small letters at its top right, and the Circuit Center
   chip logo above the card. The LOGIN button is gold with dark text.
   Wrong looks worth reporting: the whole page is pale/white (no dark green
   anywhere) · the green area looks like bumpy little tiles instead of one
   smooth surface · the logo is a grey 3D cube instead of the chip wordmark.

2. **Log in. Look at the overall shape.**
   Should be: three rounded pale panels "floating" over the dark green
   board, with thin dark-green gaps visible between them; at the far LEFT
   edge, a dark strip with small gold stripes down its side (like the gold
   fingers on a memory stick) — the section you're in (Mail) is lit gold.
   Wrong: everything edge-to-edge white with no dark gaps · no gold
   fingers on the left strip.

3. **The folder list (left panel).**
   Should be: "U1 · FOLDERS"-style small gold label at the top; folders
   with unread mail show a small GOLD pill with a dark number.
   Wrong: blue pills or blue highlights anywhere (blue = the stock theme
   leaking through — report exactly where you saw it).

4. **The message list (middle panel).**
   Should be: unread messages in darker, heavier text with a small deep-gold
   dot glowing softly at the left of the row; the message you click turns
   soft GOLD-tinted (not a solid colored bar); sender names and dates are in
   a typewriter-style font.
   Wrong: blue selection bar · unreadable pale grey text · rows taller or
   more spread out than the old theme.

5. **Open a message.**
   Should be: the subject sits on a slightly raised pale card; a normal
   email (newsletter, order confirmation) shows on its own clean WHITE
   sheet with rounded corners, exactly as the sender designed it. The area
   BEHIND the message text must be solid pale — if you can see the dark
   green board THROUGH the message text area (like frosted glass where
   you're reading), report it: reading surfaces must be solid.

6. **Reply or compose.**
   Should be: form fields look gently sunken into the surface; clicking
   into a field gives it a GOLD edge (never blue); recipient names become
   small chips in typewriter font; exactly ONE gold button (Send/Save) —
   other buttons look like frosted glass; Delete, where present, is quiet
   red text, not a big red button.

7. **Narrow the browser window until it's phone-shaped** (drag the edge).
   Should be: the floating-panels look goes away — everything becomes
   edge-to-edge and solid, still readable, still gold-accented.

8. **If anything animated seems frozen or the page looks broken right
   after a redeploy:** hard-refresh first (Cmd/Ctrl+Shift+R) and check
   again before reporting — a stale cached copy looks identical to a real
   bug.

Live-verified so far (2026-07-31, Roundcube 1.6.x): steps 1 and 7's login
half — both stylesheets serve 200, served files byte-identical to the repo,
login rendered correctly at 1440px and phone width (open bench, opaque
card, zero backdrop-filter on phone) after the carve-out and
background-size fixes; the served wordmark renders correctly when pointed
at (awaits the Install step 3 config line to activate). The `!important`
audit below produced the seven mirrors in section 11 of the stylesheet.
Steps 2–6 (logged-in views) await the owner's account.

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
- **A `templates/login.html` override** — considered and rejected as the way
  to activate the wordmark. Overriding the template WOULD flip `base_path`
  to this skin (making our `images/logo.svg` win the search), but it adds a
  second upstream file to diff on every Roundcube upgrade for something the
  supported `skin_logo` config line does in one verified stroke (Install
  step 3). One template override stays the budget.
