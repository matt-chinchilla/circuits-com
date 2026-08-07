<?php
/**
 * THE SEAM — pure field logic, shared by every writer of a signature.
 *
 * No Roundcube, no Imagick, no I/O, no globals. That is what lets the plugin,
 * seed-signatures.php and preview-signatures.php all require it, and it is why
 * mail/tests/ can exercise it with a sixty-line assertion runner and no
 * container.
 *
 * WHY THIS FILE IS THE WHOLE DESIGN
 * Two things now write identities.signature: the plugin, on every identity
 * save, and the seeder, on every run. If they ever composed the person array
 * differently they would fight, each overwriting the other with something
 * subtly different, and the difference would show up in sent mail rather than
 * anywhere either author was looking. They cannot, because neither composes it
 * — ccsig_person() does, once, here. "No second renderer" is a structural fact
 * rather than a promise anyone has to keep.
 *
 * WHY NO mb_* FUNCTION APPEARS
 * The local PHP that runs mail/tests/ has no mbstring (verified: 8.3.6, no
 * mbstring, no gd, no imagick, no pdo_sqlite). An mb_substr clamp would fatal
 * the very harness these tests exist to run in, while working perfectly in the
 * container — the worst split between where code is written and where it runs.
 * Clamping is PCRE with /u, which is multibyte-safe and always present.
 */

declare(strict_types=1);

/** Longest value accepted per field. Generous; these are guards, not policy. */
const CCSIG_MAX = [
    'title'   => 120,
    'phone'   => 40,
    'website' => 200,
    'label'   => 40,
    'url'     => 300,
];

/**
 * At most five social links.
 *
 * Not a technical limit — the signature's chip row is laid out for a handful,
 * and a person with eleven links has a different problem than this form solves.
 * Five is the point where the chip row stops matching the headshot's height, so
 * raising it further is a layout change rather than a constant change.
 */
const CCSIG_MAX_SOCIALS = 5;

/**
 * Display name for each social mark, keyed by its icon slug.
 *
 * THE ROUND TRIP IS LOAD-BEARING. What gets stored and rendered is the LABEL;
 * the icon is then chosen by sig_social_slug($label). So every name here must
 * slugify back to its own key, or the icon silently vanishes and the entry
 * degrades to a plain text link — which looks like a missing icon rather than a
 * bug, and would never be reported. "DEV" would break; "DEV.to" does not.
 *
 * Only the names that ucfirst() gets wrong appear here; the other forty-odd
 * fall through to the default. test_fields.php asserts the round trip for the
 * whole generated slug list, defaults included.
 */
const CCSIG_SOCIAL_NAMES = [
    'buymeacoffee'  => 'Buy Me a Coffee',
    'devto'         => 'DEV.to',
    'github'        => 'GitHub',
    'gitlab'        => 'GitLab',
    'huggingface'   => 'Hugging Face',
    'kofi'          => 'Ko-fi',
    'linkedin'      => 'LinkedIn',
    'orcid'         => 'ORCID',
    'producthunt'   => 'Product Hunt',
    'researchgate'  => 'ResearchGate',
    'soundcloud'    => 'SoundCloud',
    'stackoverflow' => 'Stack Overflow',
    'tiktok'        => 'TikTok',
    'whatsapp'      => 'WhatsApp',
    'x'             => 'X',
    'xing'          => 'XING',
    'youtube'       => 'YouTube',
];

/** The label to store for an icon slug the picker offered. */
function ccsig_social_label(string $slug): string
{
    return CCSIG_SOCIAL_NAMES[$slug] ?? ucfirst($slug);
}

/**
 * Clamp to $max CHARACTERS, not bytes, without mbstring.
 *
 * The /u flag makes `.` a code point, so a name ending in an accent cannot be
 * cut through the middle of its encoding. Invalid UTF-8 makes preg_match
 * return false rather than throw, and the fallback is to reject the value
 * entirely: a byte-clamped fragment of broken input is not more useful than
 * nothing, and it is harder to reason about.
 */
function ccsig_clamp(string $s, int $max): string
{
    if (preg_match('/^.{0,' . $max . '}/us', $s, $m) !== 1) {
        return '';
    }

    return $m[0];
}

/**
 * Strip control characters and collapse whitespace.
 *
 * sig_safe_url does NOT do this, and it matters: its scheme test is anchored
 * with ~^([a-z][a-z0-9+.\-]*):~i, so a value like "java\nscript:alert(1)" can
 * fail that test, be treated as scheme-less, and then be prefixed into
 * something a browser is willing to run. Removing the control characters first
 * means the allow-list sees the string a client would.
 */
function ccsig_clean(string $s): string
{
    $s = preg_replace('/[\x00-\x1F\x7F]+/u', '', $s) ?? '';

    return trim(preg_replace('/\s+/u', ' ', $s) ?? '');
}

/**
 * POST (or any untrusted array) -> the shape stored in preferences.
 *
 * Everything absent becomes '' rather than null. A null in a Roundcube
 * preference array is a DELETE instruction (rcube_user::save_prefs), so
 * storing null for "the user cleared this field" would remove the key instead
 * of blanking it, and the next read would fall back to the roster value the
 * user had just deleted.
 */
function ccsig_sanitize(array $raw): array
{
    $out = [];
    foreach (['title', 'phone', 'website'] as $k) {
        // The array guard that ccsig_sanitize_socials() has always had, applied
        // to the scalar fields too — the two halves of this function disagreed
        // about a hazard one of them names explicitly. A POSTed `_ccsig_title[]`
        // would otherwise raise "Array to string conversion" and store the
        // literal string "Array" as somebody's job title, which then renders in
        // every email they send.
        $value   = $raw[$k] ?? '';
        $out[$k] = is_scalar($value)
            ? ccsig_clamp(ccsig_clean((string) $value), CCSIG_MAX[$k])
            : '';
    }

    $out['socials'] = ccsig_sanitize_socials($raw['socials'] ?? []);

    // Guarded like the three above it. Unreachable today — the plugin coerces
    // this one before calling — but a seam that guards three of its four scalar
    // fields and trusts its caller for the fourth is the asymmetry those guards
    // exist to remove, and it is the caller that would have to remember.
    $head = $raw['headshot'] ?? '';
    $head = is_scalar($head) ? (string) $head : '';
    $out['headshot'] = ccsig_is_avatar_name($head) ? $head : '';

    return $out;
}

/**
 * Socials -> a label => url MAP, which is the shape the roster and
 * sig_social_row already take. Deliberately not an ordered list of pairs: the
 * map is what makes a migrated person render byte-identically to their roster
 * row, and that byte-identity is the migration's entire safety proof.
 */
function ccsig_sanitize_socials($raw): array
{
    if (!is_array($raw)) {
        return [];
    }

    $out = [];
    foreach ($raw as $label => $url) {
        if (count($out) >= CCSIG_MAX_SOCIALS) {
            break;
        }
        // A nested array here would become "Array" under a string cast and
        // raise a warning, which on the AJAX path corrupts the JSON body
        // before Roundcube ever sees it.
        if (is_array($label) || is_array($url) || is_object($url)) {
            continue;
        }
        $label = ccsig_clamp(ccsig_clean((string) $label), CCSIG_MAX['label']);
        $url   = ccsig_clamp(ccsig_clean((string) $url), CCSIG_MAX['url']);
        if ($label === '' || $url === '') {
            continue;
        }
        // One bad URL drops ITS OWN entry. Dropping the whole map would let a
        // single paste silently remove links the person never touched.
        $url = ccsig_http_url($url);
        if ($url === '') {
            continue;
        }
        $out[$label] = $url;
    }

    return $out;
}

/**
 * A link the way the rest of this codebase already treats links: prepend a
 * scheme ONLY when there is none, then require the result to be http(s).
 *
 * sig_safe_url() alone does not prepend, so `linkedin.com/in/jsmith` failed its
 * scheme test and the entry was dropped — no message, no error, and the row
 * simply empty when the person reopened the form. It was also asymmetric with
 * the Website field two rows above, which accepts a bare domain because
 * sig_web_href() prepends at render time.
 *
 * PREPENDING ONLY WHEN THERE IS NO SCHEME is what keeps this safe, and it is
 * the same shape as cccalendar::safe_http_url() and the site's own
 * safeHttpUrl(): a value that already carries one KEEPS it, so `javascript:`,
 * `data:` and `vbscript:` fall out at the allow-list rather than being
 * helpfully "fixed" into something that runs. Control characters are already
 * gone by here — ccsig_clean() strips them before this sees the string, which
 * is what stops `java\nscript:` being read as scheme-less.
 */
function ccsig_http_url(string $url): string
{
    $url = trim($url);

    if ($url === '') {
        return '';
    }

    if (strpos($url, '//') === 0) {
        $url = 'https:' . $url;
    } elseif (!preg_match('~^[a-z][a-z0-9+.\-]*:~i', $url)) {
        $url = 'https://' . $url;
    }

    return sig_safe_url($url, ['http', 'https']);
}

/**
 * The stored preferences blob -> an array, tolerating anything.
 *
 * A corrupt or truncated value must not fatal: this runs inside the settings
 * page, and a fatal there is a white screen where someone's mail used to be.
 */
function ccsig_prefs_read($blob): array
{
    return is_array($blob) ? $blob : [];
}

/** One identity's stored fields, or [] when it has none yet. */
function ccsig_prefs_entry(array $prefs, $identityId): array
{
    $entry = $prefs[(string) $identityId] ?? $prefs[(int) $identityId] ?? null;

    return is_array($entry) ? $entry : [];
}

/**
 * Which fields to render for an identity: stored if present, roster otherwise.
 *
 * The roster fallback is what makes the deploy order-independent — the plugin
 * can ship before the migration runs, and every signature keeps rendering from
 * the roster until its owner's data is actually moved. It becomes dead code
 * once the roster's personal fields are stripped, which is deliberately a
 * separate, later commit.
 */
function ccsig_fields_for($identityId, array $prefs, string $mailbox, array $roster): array
{
    $stored = ccsig_prefs_entry($prefs, $identityId);
    if ($stored !== []) {
        return $stored;
    }

    $person = $roster['people'][$mailbox] ?? [];

    return [
        'title'    => (string) ($person['title'] ?? ''),
        'phone'    => (string) ($person['phone'] ?? ''),
        'website'  => (string) ($person['website'] ?? ''),
        'socials'  => (array) ($person['socials'] ?? []),
        'headshot' => '',
        // Migration-only: renders the roster's already-hosted photo unchanged.
        // Re-encoding it into the volume instead would change the URL AND the
        // bytes, and destroy the byte-identical no-op that proves the migration
        // was safe.
        'headshot_url' => (string) ($person['headshot'] ?? ''),
    ];
}

/**
 * Compose the array sig_build() takes. The ONLY place that happens.
 *
 * Emits exactly the keys verified to reproduce the current signatures
 * byte-for-byte. Notably absent: phone_href and website_href. Both derive
 * correctly from phone/website, and storing them would let the link target
 * drift from the text beside it — a signature whose displayed number and
 * dialled number disagree is worse than one that does not link at all.
 */
function ccsig_person(array $fields, array $rosterPerson, string $avatarBase): array
{
    $person = [
        // Name is NOT self-editable and NOT sourced from identities.name.
        // no-reply@ carries name => '' with identity_name => 'Circuit Center',
        // and renders the company-only band precisely because that name is
        // empty. Taking it from the identity row would give no-reply a personal
        // block headed "Circuit Center".
        'name'    => (string) ($rosterPerson['name'] ?? ''),
        'title'   => (string) ($fields['title'] ?? ''),
        'phone'   => (string) ($fields['phone'] ?? ''),
        'website' => (string) ($fields['website'] ?? ''),
        'email'   => (string) ($rosterPerson['email'] ?? ''),
        'socials' => ccsig_sanitize_socials($fields['socials'] ?? []),
    ];

    $person['headshot'] = ccsig_headshot_url($fields, $avatarBase);

    // The one exception to "no hrefs", and the asymmetry is the whole point:
    // these are read from the ROSTER, never from $fields. The roster is a
    // git-tracked file only an administrator edits, and it documents these as
    // the escape hatch for a number sig_tel_href() cannot derive — an
    // international one, say. Routing the seeder through this function without
    // them would have silently retired a documented feature, leaving the
    // roster's own instructions describing something that no longer happened.
    //
    // A person still cannot set them for themselves. That is the rule the long
    // comment above is about: a signature whose displayed number and dialled
    // number disagree is worse than one that does not link at all.
    foreach (['phone_href', 'website_href'] as $override) {
        $value = trim((string) ($rosterPerson[$override] ?? ''));
        if ($value !== '') {
            $person[$override] = $value;
        }
    }

    return $person;
}

/**
 * The headshot URL, from either an uploaded FILENAME or the migration
 * passthrough. Returns '' when there is none, which removes the photo column
 * rather than leaving a gap.
 *
 * A filename is stored, never a URL: the base is configuration, so rehosting is
 * a config change instead of a rewrite of every stored row, and a stored
 * absolute URL is the shape that lets an arbitrary value reach an <img src>.
 */
function ccsig_headshot_url(array $fields, string $avatarBase): string
{
    $name = (string) ($fields['headshot'] ?? '');
    if ($name !== '' && ccsig_is_avatar_name($name)) {
        $base = rtrim(trim($avatarBase), '/');

        return $base === '' ? '' : sig_safe_url($base . '/' . $name, ['http', 'https']);
    }

    $passthrough = (string) ($fields['headshot_url'] ?? '');

    return $passthrough === '' ? '' : sig_safe_url($passthrough, ['http', 'https']);
}

/**
 * Mint an avatar filename: mailbox slug + random suffix + .jpg.
 *
 * The suffix is CACHE-BUSTING, not secrecy — a headshot goes out in every
 * email and is not private. nginx serves that directory immutable for 30 days,
 * so without a fresh name a replaced photo would keep serving the old face
 * from intermediaries for a month.
 */
function ccsig_avatar_name(string $mailbox, ?string $suffix = null): string
{
    $slug = preg_replace('/[^a-z0-9]+/', '', strtolower(explode('@', $mailbox)[0])) ?? '';
    $slug = $slug === '' ? 'user' : substr($slug, 0, 24);
    $suffix ??= bin2hex(random_bytes(4));

    return $slug . '-' . $suffix . '.jpg';
}

/**
 * Is this a filename WE minted? The only gate in front of unlink().
 *
 * Deliberately a whole-string grammar rather than a traversal blacklist:
 * "reject ../" invites the next encoding that means the same thing, while
 * "match ^[a-z0-9]{1,24}-[0-9a-f]{8}\.jpg$" cannot describe a path at all. A
 * slash, a NUL, a leading dot and a second extension are all excluded by
 * having never been included.
 */
function ccsig_is_avatar_name(string $name): bool
{
    return preg_match('/^[a-z0-9]{1,24}-[0-9a-f]{8}\.jpg$/', $name) === 1;
}
