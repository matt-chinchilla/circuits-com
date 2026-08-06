<?php
/**
 * signature-template.php — the pure functions.
 *
 * sig_build() has no I/O and reads no globals, which is what lets the plugin
 * call it directly and is therefore worth ASSERTING rather than assuming: the
 * whole self-service design rests on being able to render a signature from
 * supplied values, repeatedly, in one long-running process.
 */

declare(strict_types=1);

require_once __DIR__ . '/../signature-template.php';

const COMPANY = [
    'name'    => 'Circuit Center',
    'url'     => 'https://circuitcenter.ai',
    'label'   => 'circuitcenter.ai',
    'tagline' => 'Electronic components directory',
    'mark'    => 'https://circuitcenter.ai/images/apple-touch-icon.png',
    'icons'   => 'https://circuitcenter.ai/images/sig',
    'qr'      => 'https://circuitcenter.ai/images/sig/qr-circuitcenter.png',
    'qr_size' => 180,
];

// ---------------------------------------------------------------------------
T::group('sig_social_slug — matches social_slug() in make-signature-assets.py');

T::same('github', sig_social_slug('GitHub'), 'simple label lowercases');
T::same('stackoverflow', sig_social_slug('Stack Overflow'), 'a space is dropped');
T::same('devto', sig_social_slug('dev.to'), 'a dot is dropped');
T::same('kofi', sig_social_slug('Ko-fi'), 'a hyphen is dropped');
T::same('buymeacoffee', sig_social_slug('Buy Me a Coffee'), 'several spaces are dropped');
T::same('', sig_social_slug('!!!'), 'punctuation-only yields empty, not a bad filename');

// Every generated icon must be reachable from the title it was generated from.
$brands = json_decode(file_get_contents(__DIR__ . '/../signature-brand-icons.json'), true);
$missing = [];
foreach (array_keys($brands['icons']) as $title) {
    $f = __DIR__ . '/../../frontend/public/images/sig/social-' . sig_social_slug($title) . '.png';
    if (!is_file($f)) {
        $missing[] = $title;
    }
}
T::same([], $missing, 'every brand in the JSON resolves to a generated icon file');

// ---------------------------------------------------------------------------
T::group('sig_safe_url — the scheme allow-list');

T::same('', sig_safe_url('javascript:alert(1)', ['http', 'https']), 'javascript: is refused');
T::same('', sig_safe_url('data:text/html,<script>', ['http', 'https']), 'data: is refused');
T::same('', sig_safe_url('vbscript:msgbox', ['http', 'https']), 'vbscript: is refused');
T::same('', sig_safe_url('file:///etc/passwd', ['http', 'https']), 'file: is refused');
T::ok(sig_safe_url('https://example.com', ['http', 'https']) !== '', 'https is allowed');
T::ok(sig_safe_url('http://example.com', ['http', 'https']) !== '', 'http is allowed');

// ---------------------------------------------------------------------------
T::group('sig_build — purity, which the plugin depends on');

$person = [
    'name'    => 'Test Person',
    'title'   => 'Engineer',
    'phone'   => '(631) 555-0100',
    'website' => 'circuitcenter.ai',
    'email'   => 'test@circuitcenter.ai',
    'socials' => ['GitHub' => 'https://github.com/example'],
];

$a = sig_build($person, COMPANY, 'test@circuitcenter.ai');
$b = sig_build($person, COMPANY, 'test@circuitcenter.ai');
T::same($a, $b, 'called twice with the same input, byte-identical output');

$other = sig_build(['name' => 'Someone Else'], COMPANY, 'other@circuitcenter.ai');
$c = sig_build($person, COMPANY, 'test@circuitcenter.ai');
T::same($a, $c, 'an intervening call with different input does not leak state');

// ---------------------------------------------------------------------------
T::group('sig_build — a hostile social URL cannot reach an href');

$evil = sig_build(
    $person + ['socials' => ['GitHub' => 'javascript:alert(1)']],
    COMPANY,
    'test@circuitcenter.ai'
);
T::notContains('javascript:', $evil, 'javascript: never reaches the markup');

// ---------------------------------------------------------------------------
T::group('sig_build — degrades rather than breaking');

$bare = sig_build(['name' => 'Only A Name'], COMPANY, 'bare@circuitcenter.ai');
T::contains('Only A Name', $bare, 'a person with just a name still renders');
T::contains('Circuit Center', $bare, 'the company block is always present');
T::notContains('Mobile', $bare, 'no dangling label for a field that is absent');

$noPerson = sig_build([], COMPANY, 'no-reply@circuitcenter.ai');
T::contains('Circuit Center', $noPerson, 'no name at all still renders the company');

$noIcons = COMPANY;
unset($noIcons['icons'], $noIcons['qr']);
$fallback = sig_build($person, $noIcons, 'test@circuitcenter.ai');
T::contains('MOBILE', $fallback, 'with icons unconfigured the mono labels come back');
T::notContains('/images/sig/', $fallback, 'and no icon URLs are emitted');

// ---------------------------------------------------------------------------
T::group('sig_build — the QR floor is enforced, not merely documented');

$tiny = COMPANY;
$tiny['qr_size'] = 40;                       // below the decode floor
$out = sig_build($person, $tiny, 'test@circuitcenter.ai');
T::notContains('width="40"', $out, 'a qr_size under the floor is clamped up, not honoured');
