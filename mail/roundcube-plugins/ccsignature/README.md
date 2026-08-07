# ccsignature

Lets each person maintain their own email signature from
**Settings → Identities**, instead of somebody editing `signature-roster.php` on
the mail box and re-running the seeder.

The fields they get: job title, phone, website, up to five social links chosen
from the 51 marks that exist on disk, and a headshot. The Circuit Center
signature card is rebuilt from those every time they save.

## How it fits together

```
Settings > Identities  ──┐
                         ├─→ ccsig_person() ─→ sig_build() ─→ identities.signature
seed-signatures.php    ──┘
```

Both writers go through the same two functions. That is the point: two writers
composing a person even slightly differently would overwrite each other on
alternate saves, and the difference would only ever show up in sent mail.

`signature-roster.php` is still here and still matters — it is now the
**defaults**. `ccsig_fields_for()` returns a person's stored values if they have
any and the roster row if they do not, so this plugin needed no migration: on
the day it shipped every signature rendered exactly what it had the day before,
and each person's own values take over the first time they press Save.

A mailbox that is not on the roster at all (a new hire, a second identity for an
alias) takes its name from the identity row, so it gets a correct signature with
nobody touching a file. `no-reply@` is not that case — it *is* on the roster,
carrying an empty name on purpose, and that is what makes it render the company
band alone.

## Files

| File | What it is |
|---|---|
| `ccsignature.php` | The plugin. Moves values between the form, preferences and the two functions above. Renders nothing itself. |
| `ccsignature_fields.php` | The pure seam — sanitising, clamping, composing. No Roundcube, no Imagick, no I/O. Shared with the seeder. |
| `ccsignature_image.php` | The only code that touches Imagick. Bounded against the container, not against `memory_limit`. |
| `ccsignature.js` | The headshot picker, and nothing else. |
| `skins/circuitcenter/ccsignature.css` | Two composite widgets' worth of layout. Every colour has a non-skin fallback. |

## Configuration

Every value has a working default, so `config.inc.php` is genuinely optional —
see `config.inc.php.dist`. On the box the plugin directory is bind-mounted
read-only, so overrides travel as environment variables from
`/opt/circuits-mail/.env` through `docker-compose.webmail.yml`.

The plugin holds **no secret**.

## Installing

Three mounts and one name in `ROUNDCUBEMAIL_PLUGINS`, all already in
`docker-compose.webmail.yml`:

| Container path | Comes from | Holds |
|---|---|---|
| `/var/www/html/plugins/ccsignature` | `/opt/circuits-mail/plugins/ccsignature` | this directory |
| `/var/lib/ccsignature/lib` | `/opt/circuits-mail/signature` | `signature-template.php`, `signature-roster.php`, `signature-icon-slugs.php` |
| `/var/lib/ccsignature/avatars` | the `signature-avatars` volume | headshots; read-write here, read-only in `webmail-proxy` |

So the box layout is **not** a copy of `mail/`:

```
/opt/circuits-mail/
├── seed-signatures.php, seed-signatures.sh, ...
├── signature/            <- the three shared library files
└── plugins/ccsignature/  <- this plugin, including ccsignature_fields.php
```

`seed-signatures.sh` copies **only `seed-signatures.php`** into the container.
Everything else it needs is already mounted there, so it reads the library in
place — the same files the plugin loads, at the same paths.

That is deliberate and it is what makes the shared seam actually hold. Shipping
the library from the host would leave the box carrying two of each file, with
nothing keeping them equal; let them drift and the two writers of
`identities.signature` compose a person differently and overwrite each other on
alternate saves, visible nowhere but in sent mail. Reading the mounted copy makes
them the same file by construction rather than by anybody remembering.

It also means **the box does not need root-level copies of
`signature-template.php`, `signature-roster.php` or `signature-icon-slugs.php`.**
If they are there from an older copy-everything deploy, they are now unused and
can be deleted — leaving `signature/` as the one home.

**One manual step, once.** Docker creates a named volume owned by `root`, and
PHP runs as `www-data`, so the first upload would fail until:

```bash
sudo docker exec roundcube chown -R www-data:www-data /var/lib/ccsignature/avatars
```

It fails loudly rather than silently if you forget — the form says photos cannot
be saved, and the container log names the directory.

## Testing

```bash
php mail/tests/run.php            # the pure half, anywhere
mail/tests/run-in-container.sh    # everything, including the image pipeline
```

No composer, ever. The skin and both plugins ride the upstream Roundcube image
untouched precisely because nothing here pulls a dependency.

## Two things that will look like bugs and are not

- **A link renders as text instead of an icon.** The mark chooses itself from
  the label via `sig_social_slug()`, and only the 51 slugs in
  `signature-icon-slugs.php` have a file. A label that does not round-trip
  degrades to a text link — deliberately, because a text link is a degraded
  rendering and a broken image is a wrong one. `test_fields.php` asserts the
  round trip for every slug, so this can only happen to a value stored before
  the picker existed.
- **A photo uploaded and then Cancel was pressed, and the old photo is still
  there.** Correct. Uploading writes a file; which file an identity *points at*
  is only decided on Save.
- **Unsaved uploads are never deleted.** Trying three photos before picking one
  leaves two files in the volume that nothing collects, and that is deliberate.
  Reaping them means unlinking the previous upload when the next arrives — which
  with the same identity open in two tabs deletes the file the first tab is
  still holding, so saving it stores a filename whose file is gone. The server
  cannot know what another tab has on screen, so no comparison closes it. Each
  orphan is one ~54KB JPEG for one of five people; leaving them fails visibly on
  disk rather than silently in somebody's outgoing mail.
