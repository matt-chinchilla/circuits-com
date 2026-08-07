<?php
/**
 * ccsignature_fields.php — the seam both writers go through.
 *
 * The headline assertion is the byte-identity one: a person composed from
 * migrated fields must render EXACTLY what the roster renders today. That is
 * the migration's entire safety proof, and it is the reason the seeder's
 * post-migration dry run can be required to report zero changes.
 */

declare(strict_types=1);

require_once __DIR__ . '/../signature-template.php';
require_once __DIR__ . '/../roundcube-plugins/ccsignature/ccsignature_fields.php';

$ROSTER = require __DIR__ . '/../signature-roster.php';
const AVATARS = 'https://mail.circuitcenter.ai/avatars';

// ---------------------------------------------------------------------------
T::group('byte identity — a migrated person renders what the roster renders');

foreach ($ROSTER['people'] as $mailbox => $rosterPerson) {
    $before = sig_build($rosterPerson, $ROSTER['company'], $mailbox);

    // Exactly what the migration will store, then read back through the seam.
    $fields = ccsig_fields_for(1, [], $mailbox, $ROSTER);
    $after  = sig_build(
        ccsig_person($fields, $rosterPerson, AVATARS),
        $ROSTER['company'],
        $mailbox
    );

    T::same(strlen($before), strlen($after), "{$mailbox}: same length");
    T::same($before, $after, "{$mailbox}: byte-identical through the seam");
}

// ---------------------------------------------------------------------------
T::group('every platform name slugifies back to its own icon');

// The picker stores a LABEL; sig_social_slug($label) then chooses the icon. A
// name that does not round-trip produces no <img> at all and the entry degrades
// to a plain text link — which reads as a missing icon rather than as a bug, so
// nobody would ever report it. Asserted for the whole generated list, defaults
// included, because ucfirst() is as capable of being wrong as the map is.
$SLUGS = require __DIR__ . '/../signature-icon-slugs.php';

foreach ($SLUGS as $slug) {
    $label = ccsig_social_label($slug);
    T::same($slug, sig_social_slug($label), "{$slug}: \"{$label}\" slugifies back");
}

foreach (array_keys(CCSIG_SOCIAL_NAMES) as $slug) {
    T::ok(in_array($slug, $SLUGS, true), "CCSIG_SOCIAL_NAMES['{$slug}'] names a mark that exists");
}

// ---------------------------------------------------------------------------
T::group('clamping is multibyte-safe and never calls mb_*');

$src = file_get_contents(__DIR__ . '/../roundcube-plugins/ccsignature/ccsignature_fields.php');
T::ok(!preg_match('/\bmb_[a-z_]+\s*\(/', $src),
    'no mb_* call — local PHP has no mbstring and it would fatal this harness');

T::same('abc', ccsig_clamp('abcdef', 3), 'clamps to length');
T::same('héllo', ccsig_clamp('héllo wörld', 5), 'counts characters, not bytes');
T::ok(strlen(ccsig_clamp(str_repeat('é', 50), 10)) === 20,
    'ten accented characters are twenty bytes, not ten');
T::same('', ccsig_clamp("\xC3\x28", 10), 'invalid UTF-8 is rejected outright, not half-cut');

// ---------------------------------------------------------------------------
T::group('control characters are stripped BEFORE the URL allow-list sees them');

$s = ccsig_sanitize(['socials' => ['X' => "java\nscript:alert(1)"]]);
T::same([], $s['socials'], 'a newline inside a scheme does not smuggle it past sig_safe_url');

$t = ccsig_sanitize(['title' => "CEO\x00\x07 & Founder"]);
T::same('CEO & Founder', $t['title'], 'NUL and BEL are removed from a plain field');

// ---------------------------------------------------------------------------
T::group('hostile social URLs drop themselves, not the whole map');

$mixed = ccsig_sanitize(['socials' => [
    'GitHub'   => 'https://github.com/ok',
    'Bad'      => 'javascript:alert(1)',
    'LinkedIn' => 'https://www.linkedin.com/in/ok',
]]);
T::same(['GitHub' => 'https://github.com/ok', 'LinkedIn' => 'https://www.linkedin.com/in/ok'],
    $mixed['socials'], 'the good entries survive and only the bad one is dropped');

foreach (['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd'] as $bad) {
    $r = ccsig_sanitize(['socials' => ['L' => $bad]]);
    T::same([], $r['socials'], "refused: {$bad}");
}

// ---------------------------------------------------------------------------
T::group('a link typed without a scheme still works');

// It used to be dropped in silence: sig_safe_url() does not prepend, so a bare
// domain failed its scheme test, the entry vanished, and the row was simply
// empty when the person reopened the form. It was also asymmetric with the
// Website field, which accepts a bare domain because sig_web_href() prepends.
foreach ([
    'linkedin.com/in/jsmith' => 'https://linkedin.com/in/jsmith',
    'www.github.com/me'      => 'https://www.github.com/me',
    '//example.com/x'        => 'https://example.com/x',
    'http://example.com/x'   => 'http://example.com/x',
    'https://example.com/x'  => 'https://example.com/x',
] as $typed => $expected) {
    T::same(['L' => $expected], ccsig_sanitize(['socials' => ['L' => $typed]])['socials'],
        "accepted: {$typed}");
}

// Prepending must happen ONLY when there is no scheme, or it "fixes" a hostile
// value into something that runs. A value that already carries a scheme keeps
// it, and therefore still dies at the allow-list.
foreach (['javascript:alert(1)', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd'] as $bad) {
    T::same([], ccsig_sanitize(['socials' => ['L' => $bad]])['socials'],
        "still refused after the prepend change: {$bad}");
}

// ---------------------------------------------------------------------------
T::group('a non-scalar field cannot become the string "Array"');

foreach (['title', 'phone', 'website'] as $field) {
    $r = ccsig_sanitize([$field => ['x']]);
    T::same('', $r[$field], "{$field}: an array value yields '', never \"Array\"");
}

// ---------------------------------------------------------------------------
T::group('socials: caps, empties, and values that are not strings');

$many = [];
for ($i = 0; $i < 8; $i++) {
    $many["L{$i}"] = "https://example.com/{$i}";
}
T::same(CCSIG_MAX_SOCIALS, count(ccsig_sanitize(['socials' => $many])['socials']),
    'capped at ' . CCSIG_MAX_SOCIALS);

T::same([], ccsig_sanitize(['socials' => ['' => 'https://example.com']])['socials'],
    'an empty label is dropped, not rendered half-formed');
T::same([], ccsig_sanitize(['socials' => ['GitHub' => '']])['socials'], 'an empty URL is dropped');
T::same([], ccsig_sanitize(['socials' => ['GitHub' => ['nested']]])['socials'],
    'an array value is dropped, never cast to the string "Array"');
T::same([], ccsig_sanitize(['socials' => 'not-an-array'])['socials'], 'a scalar socials value yields []');

// ---------------------------------------------------------------------------
T::group('ccsig_person never emits phone_href or website_href');

$p = ccsig_person(
    ['title' => 'T', 'phone' => '(631) 555-0100', 'website' => 'example.com',
     'phone_href' => 'https://evil.example', 'website_href' => 'https://evil.example'],
    ['name' => 'N', 'email' => 'n@circuitcenter.ai'],
    AVATARS
);
T::ok(!array_key_exists('phone_href', $p), 'phone_href is not carried through');
T::ok(!array_key_exists('website_href', $p), 'website_href is not carried through');

// ...but the ROSTER may still set them, and must, or routing the seeder through
// this function would silently retire the documented escape hatch for a number
// sig_tel_href() cannot derive. Admin-authored file: yes. Anything a person can
// type into the identity form: never.
$override = ccsig_person(
    ['phone' => '+44 20 7946 0958', 'website' => 'example.com',
     'phone_href' => 'tel:+00000000000', 'website_href' => 'https://evil.example'],
    ['name' => 'N', 'phone_href' => 'tel:+442079460958', 'website_href' => 'https://example.com/uk'],
    AVATARS
);
T::same('tel:+442079460958', $override['phone_href'], 'the roster may override the dial target');
T::same('https://example.com/uk', $override['website_href'], 'and the website target');

$empty = ccsig_person(['phone' => '1'], ['name' => 'N', 'phone_href' => '   '], AVATARS);
T::ok(!array_key_exists('phone_href', $empty), 'a blank roster override stays absent, not empty');

// ---------------------------------------------------------------------------
T::group('avatar filenames: only what we minted');

$good = ccsig_avatar_name('matthew@circuitcenter.ai', 'deadbeef');
T::same('matthew-deadbeef.jpg', $good, 'minted from the mailbox plus a suffix');
T::ok(ccsig_is_avatar_name($good), 'and it validates');

foreach ([
    '../../etc/passwd', '/etc/passwd', 'a/b.jpg', "ok-deadbeef.jpg\x00.php",
    'ok-deadbeef.php', 'ok-deadbeef.jpg.php', '.-deadbeef.jpg', 'ok-XYZ.jpg',
    'ok-deadbeef.JPG', str_repeat('a', 25) . '-deadbeef.jpg', '', 'ok-deadbee.jpg',
] as $bad) {
    T::ok(!ccsig_is_avatar_name($bad), 'refused: ' . var_export($bad, true));
}

T::same('', ccsig_sanitize(['headshot' => '../../etc/passwd'])['headshot'],
    'a traversal filename never reaches storage');

// ---------------------------------------------------------------------------
T::group('headshot URL composition');

$withFile = ccsig_person(['headshot' => 'matthew-deadbeef.jpg'], ['name' => 'N'], AVATARS);
T::same(AVATARS . '/matthew-deadbeef.jpg', $withFile['headshot'], 'filename joins the base');

$passthrough = ccsig_person(
    ['headshot' => '', 'headshot_url' => 'https://circuitcenter.ai/images/team/matthew.jpg'],
    ['name' => 'N'], AVATARS
);
T::same('https://circuitcenter.ai/images/team/matthew.jpg', $passthrough['headshot'],
    'the migration passthrough renders the existing hosted photo unchanged');

T::same('', ccsig_person(['headshot' => '', 'headshot_url' => 'javascript:alert(1)'],
    ['name' => 'N'], AVATARS)['headshot'], 'a hostile passthrough is refused');
T::same('', ccsig_person([], ['name' => 'N'], '')['headshot'], 'no base configured yields no photo');

// ---------------------------------------------------------------------------
T::group('saving does not silently drop a roster-hosted photo');

// ccsig_sanitize() deliberately does NOT carry headshot_url — it sanitises what
// a CLIENT sent, and a client-supplied photo URL would put an arbitrary remote
// image into outgoing mail. The consequence is a trap: anything that stores only
// its output drops the roster's hosted photo, so the first person to save any
// unrelated change loses their own face from every email they send, visible
// nowhere but the recipient's inbox. The plugin re-adds headshot_url from the
// server side; this asserts both halves of that, because deleting either one
// reintroduces the bug.
$who    = 'matthew@circuitcenter.ai';
$shown  = ccsig_fields_for(1, [], $who, $ROSTER);
$hosted = $shown['headshot_url'];

T::ok($hosted !== '', 'the fixture person really does have a roster-hosted photo');
T::ok(!array_key_exists('headshot_url', ccsig_sanitize($shown)),
    'ccsig_sanitize drops headshot_url — a client must never choose it');

$naive = ccsig_person(ccsig_sanitize($shown), $ROSTER['people'][$who], AVATARS);
T::same('', $naive['headshot'], 'storing sanitize() alone WOULD lose the photo');

$stored = ccsig_sanitize($shown) + ['headshot_url' => $hosted];
$kept   = ccsig_person($stored, $ROSTER['people'][$who], AVATARS);
T::same($hosted, $kept['headshot'], 'carrying headshot_url forward keeps it');

// An uploaded file must win over the passthrough, or replacing a photo would
// appear to do nothing.
$replaced = ccsig_person(
    ['headshot' => 'matthew-deadbeef.jpg', 'headshot_url' => $hosted], ['name' => 'N'], AVATARS
);
T::same(AVATARS . '/matthew-deadbeef.jpg', $replaced['headshot'], 'an upload overrides the passthrough');

// ---------------------------------------------------------------------------
T::group('preferences reading tolerates rubbish');

T::same([], ccsig_prefs_read(null), 'null blob');
T::same([], ccsig_prefs_read('a:1:{s:5:"trunc'), 'a truncated serialized string');
T::same([], ccsig_prefs_read(42), 'an integer');
T::same([], ccsig_prefs_entry(['1' => 'not-an-array'], 1), 'a non-array entry');
T::same(['title' => 'X'], ccsig_prefs_entry(['7' => ['title' => 'X']], 7), 'a string key matches an int id');

// ---------------------------------------------------------------------------
T::group('nothing is stored as null — null means DELETE in Roundcube prefs');

foreach (ccsig_sanitize([]) as $k => $v) {
    T::ok($v !== null, "{$k} is '' rather than null");
}
