# Circuit Center — Roundcube skin

A dark, PCB-native skin for Roundcube 1.6, derived from Elastic.
Design rationale, palette and contrast measurements are in [DESIGN.md](DESIGN.md).

```
circuitcenter/
├── meta.json                        skin manifest ("extends": "elastic")
├── templates/includes/layout.html   the ONE template override
├── styles/circuitcenter.css         the whole skin
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

It then rides on Elastic's own dark stylesheet. `templates/includes/layout.html`
puts `dark-mode` on `<html>`, which switches on the ~1100 lines of `dark.less`
that Roundcube already ships and that already cover every widget down to
TinyMCE and jQuery-UI. `styles/circuitcenter.css` loads after it and re-tints.
That is why this skin is one CSS file instead of a fork: **we are not
re-implementing a dark theme, we are colouring one in.**

`<html>` also carries `cc`. Every rule in `circuitcenter.css` is written as
`html.cc …`, mirroring Elastic's `html.dark-mode …` selector so specificity
ties and load order decides. `cc` is ours and Roundcube's `ui.js` never touches
it, so the layer cannot be stripped out from under us.

`dark_mode_support` is set to `false`. The skin is dark-only by intent, so the
Settings light/dark toggle is hidden rather than left present and inert.

### The one non-obvious thing

Upstream's `layout.html` links `/styles/styles.css`, **a file that exists in no
Roundcube distribution** — releases ship `styles.min.css` only. Elastic gets
away with it because `rcmail_output_html::file_mod()` silently rewrites a
missing `.css` to `.min.css`, and it does that lookup relative to `$base_path`,
which is "whichever skin the template was found in". The moment this skin
overrides `layout.html`, `$base_path` becomes `skins/circuitcenter`, the `.min`
swap looks in the wrong directory, and Elastic's entire stylesheet 404s.

So our copy names the minified files explicitly. If you ever run against a
build that has an unminified `styles.css` and no `styles.min.css`, drop the two
`.min` in `templates/includes/layout.html`.

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

No restart is needed for CSS edits — Roundcube appends an mtime cache-buster to
every skin asset. Changing `config.inc.php` does need the container restarting.

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

# 3. Nothing reaches off-host, and no animation loop was introduced.
#    Expect matches in comments only.
grep -nE '@keyframes|animation:|@import|https?://|requestAnimationFrame' \
  "$ROUNDCUBE_ROOT/skins/circuitcenter/styles/circuitcenter.css"
```

Then open the webmail and check: the task rail shows gold contact fingers with
the active task lit; panel legends read `FOLDERS` / `INBOX` in gold monospace;
unread rows carry a gold pip; the empty reading pane shows a board coupon.

## Upgrading Roundcube

Two things to re-check, both cheap.

**1. `layout.html` drift.** Our copy is upstream's file with three marked
changes (they are listed at the top of the file). Diff it:

```bash
diff -u "$ROUNDCUBE_ROOT/skins/elastic/templates/includes/layout.html" \
        "$ROUNDCUBE_ROOT/skins/circuitcenter/templates/includes/layout.html"
```

Anything beyond those three changes is new upstream work to port in.

**2. New `:not()` guards in `dark.less`.** Elastic guards some dark rules with
`:not()`, and every `:not(.foo)` silently adds a class's worth of specificity —
a plainly-mirrored selector then loses. Section 10 of `circuitcenter.css`
exists solely to match those guards. Re-run the audit after an upgrade:

```bash
grep -o 'html\.dark-mode[^,{]*:not([^,{]*' \
  "$ROUNDCUBE_ROOT/skins/elastic/styles/styles.min.css" | sort -u
```

Anything in that list touching a property this skin sets needs a mirror in
section 10. (At 1.6.11 there were 41 such selectors; 13 of them mattered.)

## Constraints this skin holds to

- **No perpetual animation** — no `@keyframes`, no `animation`, no
  `requestAnimationFrame`, no `<canvas>`. Hover/focus transitions only, and
  `prefers-reduced-motion` neutralises those.
- **Offline-safe** — no CDN, no webfont, no remote image, no `@import`. Type is
  the OS-native stack; icons stay Elastic's self-hosted Font Awesome.
- **Contrast** — body text ≥ 4.5:1, non-text UI ≥ 3:1. Verified in a browser
  against the real compiled Elastic stylesheet: 67 text nodes, minimum 4.94:1,
  zero failures.
- **Density untouched** — no row height, padding or breakpoint of Elastic's is
  changed.

## Not included, on purpose

- **`styles/embed.css`** — inherited from Elastic, which keeps HTML mail bodies
  and the compose editor on white. Sender-styled HTML forced into a dark
  palette is how dark webmail clients wreck newsletters, and a WYSIWYG editor
  should show what the recipient will see. The white sheet is framed instead of
  recoloured.
- **A light mode** — one theme means one audited contrast set. Printing is
  handled separately (section 11 hands the page back to ink-on-white).
- **A logo** — set `$config['skin_logo']` if you want one; Roundcube's own is
  used otherwise.
