# Self-service signature fields, in Settings → Identities

Date: 2026-08-06
Status: awaiting review

## What this is

A Roundcube plugin, `ccsignature`, that lets each person maintain their own
signature details from Settings → Identities: title, phone, website, social
links, and a headshot they upload themselves. On save it regenerates their
signature from the existing template.

Today those details live in `signature-roster.php` and only change when someone
with SSH access edits that file and re-runs `seed-signatures.sh`. Daniel,
Anthony and Ronald have had empty titles and phone numbers since the roster was
written, for exactly that reason.

Explicitly NOT in scope: editing the company block, the QR, the backdrop, the
card, fonts, colours or layout. Those stay centrally controlled, so a bad entry
can make someone's own row wrong but cannot make the signature broken. Also not
in scope: a raw-HTML escape hatch, which would discard every property the
template guarantees — alt text, the opaque plates, the decode-verified QR size,
Outlook's renderer.

## Why it lives where it does

**A plugin, mirroring `cccalendar`.** That precedent is already proved on this
box: one `:ro` volume, one more name in `ROUNDCUBEMAIL_PLUGINS`, no composer
dependencies, so the upstream Roundcube image is untouched and patch releases
keep arriving for free.

**The template is already a pure function.** `sig_build($person, $company,
$mailbox)` does no I/O and reads no globals, so the plugin can `require` it and
call it directly. The signature the plugin writes is byte-identical to what
`preview-signatures.php` prints for the same inputs — there is no second
renderer to keep in step.

**Roundcube's own hooks do the work.** `identity_form` injects the fields;
`identity_save` receives them. Both exist in 1.6 and are what the settings UI is
built on, so nothing upstream is forked.

## Ownership: a seam, not a precedence rule

The roster stops carrying personal fields. After this:

| `signature-roster.php` | Roundcube, per user |
| --- | --- |
| company name, url, label, tagline | title |
| mark, icons base, QR, backdrop | phone, website |
| tier sizes and layout constants | social links |
| | headshot |

Nothing is written in two places, so the two can never disagree and
`seed-signatures.sh` needs no rule about who wins. It keeps working: it renders
whatever personal fields Roundcube holds against the roster's company block.

**The cost, stated plainly:** personal details leave the repo. A rebuilt mail
box needs them re-entered, or restored from the SQLite backup that
`seed-signatures.sh` already takes on every run. That backup becomes load
bearing rather than incidental, and the migration below is what makes the first
one exist.

## Data

Roundcube's `identities` table is upstream's and must not gain columns — a
schema change is exactly the kind of thing a Roundcube upgrade steps on. The
plugin stores its fields in **user preferences** (`users.preferences`, the
serialized array Roundcube already keeps per user), under a single `ccsignature`
key holding a map of `identity_id → fields`.

    ccsignature => [
        1 => [
            'title'    => 'CEO & Founder',
            'phone'    => '(631) 560-9048',
            'website'  => 'circuitcenter.ai',
            'socials'  => ['GitHub' => 'https://…', 'LinkedIn' => 'https://…'],
            'headshot' => 'matthew-7f3a91.jpg',   // filename, not a URL
            'updated'  => '2026-08-06T15:04:05Z',
        ],
    ]

The headshot is stored as a FILENAME, not a URL. The base is config, so moving
the host later is a config change rather than a rewrite of every row — and a
stored absolute URL is the shape that would let a bad value reach an `<img src>`.

## The headshot

**It must be a public, unauthenticated URL.** The image is fetched by the
RECIPIENT's mail client, which has no Roundcube session, and `data:` URIs are
stripped by Gmail and Outlook — that constraint is already recorded in the
roster and is why the company mark is hosted rather than embedded. So this
cannot be served through a session-gated plugin action.

A new writable volume, `signature-avatars`, mounted into `roundcube` (write) and
`webmail-proxy` (read). nginx serves it at
`https://mail.circuitcenter.ai/avatars/<file>` as static files: no PHP in the
fetch path, and cacheable.

Two domains then appear in one signature — assets on `circuitcenter.ai`, the
headshot on `mail.circuitcenter.ai`. Accepted deliberately: the alternative is a
cross-box upload path to the web box, which means an authenticated API call, a
second set of credentials on the mail box, and a failure mode where the webmail
is up and saving a photo is not.

### Memory is the real constraint

`memory_limit` is **64M** and `upload_max_filesize` is **25M**. An iPhone photo
is 4032×3024; `imagecreatefromjpeg` allocates roughly 48MB for the bitmap alone
and would exhaust the limit before any resizing happened. This is not a
theoretical edge — it is the first photo anyone uploads.

So GD is not used for decoding. Imagick's `setSize()` hint lets libjpeg decode a
JPEG at 1/2, 1/4 or 1/8 scale directly through DCT scaling, so peak memory is
bounded by the OUTPUT size rather than the input. Order of operations:

1. `getimagesize()` first — reads the header only, no decode. Reject anything
   not `image/jpeg`, `image/png` or `image/webp`, or larger than 8000px a side.
2. `Imagick::setSize()` to the smallest scale that still exceeds 288px.
3. Read, strip all profiles and EXIF, centre-crop square, resize to 288.
4. Re-encode as JPEG quality 88. **Re-encoding is the security boundary**: the
   bytes written are ones this code produced, so a polyglot or a payload in a
   comment segment does not survive.
5. Write under a filename with a random suffix, and delete the previous file.

The random suffix is cache-busting, not secrecy — a headshot goes out in every
email and is not private. Without it, a replaced photo keeps serving from
intermediaries under the old URL.

## The icons

51 networks ship with real marks, sourced from **simple-icons** rather than
drawn from memory — a wrong path renders a subtly wrong logo, which is worse
than none. Generated into `frontend/public/images/sig/` by the existing
`make-signature-assets.py`, alongside the ones already there.

Any other label still works and renders as a text link, which is the roster's
existing promise and needs no new icon to be useful.

**Six deliberately have no icon: LinkedIn, Slack, Skype, CodePen, AngelList and
Twitter.** The first five were REMOVED from simple-icons at the brand owner's
request; Twitter is superseded by X. Shipping a mark whose owner asked for it to
be withdrawn is the thing the withdrawal was asking people not to do, so those
render as text links. LinkedIn is the exception: the signature already carries a
LinkedIn mark that predates this and renders correctly, and it stays.

Using a brand's mark to link to your own profile on that service is nominative
use and is what these icons are for. Nothing here re-publishes an icon set or
implies endorsement.

## Security

- **Upload**: type sniffed from content via `getimagesize()`, never from the
  filename or the client's Content-Type. Dimension cap before decode. Re-encoded
  on write. Fixed extension; the client's filename is never used on disk.
- **Serving**: nginx serves the avatar directory with `default_type image/jpeg`
  and no `index`, so nothing in it can be interpreted.
- **URLs**: every social link goes through the template's existing
  `sig_safe_url`, which allow-lists http(s). A `javascript:` URL in a field that
  becomes an `href` is the stored-XSS shape this repo has been bitten by before.
- **Authorization**: a user can only write their own identities. Roundcube's
  `identity_save` already scopes to the session's user; the plugin must not
  accept an `identity_id` from the request without re-checking ownership.
- **Rate**: uploads are capped per user per hour, so a writable public directory
  cannot be filled from a single session.

## Migration

A one-shot script reads the current roster's personal fields into each user's
preferences, so nobody loses what is already there and the first
`seed-signatures.sh` after the change is a no-op. The roster's personal fields
are then deleted in the same commit — leaving them would recreate exactly the
two-places problem the ownership split exists to avoid.

## Testing

- unit: field validation — bad URL schemes, oversized images, wrong types,
  a filename that tries to traverse
- unit: `sig_build` output is byte-identical whether fields come from the roster
  or from preferences, for the same values
- integration: save an identity, assert the signature in the DB regenerated
- integration: a second user cannot write the first user's identity
- image: a 4032×3024 JPEG processes within the 64M limit — the case that
  motivated Imagick, asserted rather than assumed
- image: an uploaded file with appended non-image data does not survive the
  re-encode
- guard: the avatar URL resolves without a session

## Open, deliberately deferred

- No admin view of everyone's fields. Five people; the DB is one query away.
- No approval step before a signature changes. Adding one means a queue and a
  reviewer, and the field scope already prevents structural damage.
- Headshots are not backed up separately from the volume. If that matters, the
  volume joins whatever backs up `roundcube-data`, which today is nothing —
  worth raising on its own rather than solving inside this feature.
