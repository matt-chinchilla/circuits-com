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
