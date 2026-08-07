<?php
/**
 * ccsignature_image.php — the Imagick half.
 *
 * SKIPS LOUDLY when Imagick is absent, which is the normal case on the machine
 * this repo is edited from (PHP 8.3.6, no imagick, no gd). It must never pass
 * silently there: a green run that proved nothing is worse than a visible skip,
 * because the whole risk this file guards — an OOM-killed container — only
 * exists in the place these tests cannot reach from.
 *
 * Run them where they matter:
 *     mail/tests/run-in-container.sh
 */

declare(strict_types=1);

require_once __DIR__ . '/../roundcube-plugins/ccsignature/ccsignature_image.php';

if (!extension_loaded('imagick')) {
    echo "\n  \033[33mSKIPPED\033[0m — no imagick on this PHP.\n";
    echo "    These assertions are about the roundcube container's memory ceiling,\n";
    echo "    which cannot be observed from here. Run: mail/tests/run-in-container.sh\n";
    return;
}

$tmp = sys_get_temp_dir() . '/ccsig-test-' . bin2hex(random_bytes(4));
@mkdir($tmp, 0700, true);
register_shutdown_function(static function () use ($tmp) {
    foreach (glob($tmp . '/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($tmp);
});

/** A noisy JPEG, so the encoder cannot cheat its way to a tiny file. */
function ccsig_test_photo(string $path, int $w, int $h, int $orientation = 1): void
{
    $im = new Imagick();
    $im->newPseudoImage($w, $h, 'plasma:fractal');
    $im->setImageFormat('jpeg');
    $im->setImageOrientation($orientation);
    $im->writeImage($path);
    $im->clear();
}

// ---------------------------------------------------------------------------
T::group('a real iPhone-sized photo stays inside PHP memory');

$big = $tmp . '/big.jpg';
ccsig_test_photo($big, 4032, 3024);
$out = $tmp . '/out.jpg';

// Asserted in a SUBPROCESS with an explicit -d memory_limit, because
// memory_get_peak_usage in THIS process is already polluted by the harness and
// by generating the fixture. A clean process is the only honest measurement.
$script = $tmp . '/peak.php';
file_put_contents($script, '<?php
require ' . var_export(__DIR__ . '/../roundcube-plugins/ccsignature/ccsignature_image.php', true) . ';
ccsig_image_process(' . var_export($big, true) . ', ' . var_export($out, true) . ');
echo round(memory_get_peak_usage(true) / 1048576, 2);
');
$peak = (float) shell_exec(PHP_BINARY . ' -d memory_limit=64M ' . escapeshellarg($script) . ' 2>&1');

T::ok($peak > 0 && $peak < 64, sprintf('PHP peak %.2f MB, under the 64M limit', $peak));
T::ok(is_file($out), 'an output file was written');
$dims = getimagesize($out);
T::same([CCSIG_AVATAR_PX, CCSIG_AVATAR_PX], [$dims[0], $dims[1]], 'output is 288x288');
T::same('image/jpeg', $dims['mime'], 'output is JPEG');

// ---------------------------------------------------------------------------
T::group('the re-encode is the security boundary');

$poly = $tmp . '/poly.jpg';
ccsig_test_photo($poly, 600, 600);
file_put_contents($poly, "\n<?php system(\$_GET['c']); __HALT__\n", FILE_APPEND);
T::ok(str_contains(file_get_contents($poly), '<?php'), 'the fixture really does carry a payload');

$clean = $tmp . '/clean.jpg';
ccsig_image_process($poly, $clean);
T::notContains('<?php', file_get_contents($clean), 'the payload does not survive re-encoding');
T::notContains('system(', file_get_contents($clean), 'nor any of its body');

// ---------------------------------------------------------------------------
T::group('EXIF orientation is applied before it is stripped');

// Assert the PIXELS moved, not the tag.
//
// TWO earlier versions of this test were wrong, and both failed against
// CORRECT code, which is worth recording:
//
//   1. Asserting the output's orientation tag is TOPLEFT. It is UNDEFINED,
//      rightly: stripImage() runs after auto-orient and removes all metadata,
//      so the rotation is baked into the pixels and no tag remains to rotate
//      them a second time.
//
//   2. Building the fixture with setImageOrientation() + writeImage(). That
//      sets an in-memory property which is NOT written into the JPEG — read
//      back from disk the orientation was 0. The fixture therefore declared
//      nothing, auto-orient correctly did nothing, and the test was measuring
//      its own mistake.
//
// So the fixture gets a REAL EXIF APP1 segment, spliced in by hand. A phone
// photo carries exactly this, which is the case that matters: without
// auto-orient a portrait selfie arrives in the signature lying on its side.
function ccsig_test_exif_orientation(string $jpeg, int $orientation): string
{
    // APP1: "Exif\0\0", little-endian TIFF header, one IFD entry —
    // tag 0x0112 (Orientation), type 3 (SHORT), count 1, value.
    $tiff = "II*\x00" . pack('V', 8)
          . pack('v', 1)
          . pack('v', 0x0112) . pack('v', 3) . pack('V', 1)
          . pack('v', $orientation) . "\x00\x00"
          . pack('V', 0);
    $payload = "Exif\x00\x00" . $tiff;
    $app1    = "\xFF\xE1" . pack('n', strlen($payload) + 2) . $payload;

    // Insert immediately after SOI, before any other marker.
    return substr($jpeg, 0, 2) . $app1 . substr($jpeg, 2);
}

$rot = $tmp . '/rot.jpg';
$red = new Imagick();
$red->newImage(200, 400, new ImagickPixel('red'));
$blu = new Imagick();
$blu->newImage(200, 400, new ImagickPixel('blue'));
$red->addImage($blu);
$red->resetIterator();
$joined = $red->appendImages(false);          // 400x400, red | blue
$joined->setImageFormat('jpeg');
$plain = $joined->getImageBlob();
$red->clear();
$blu->clear();
$joined->clear();

// 6 = RIGHTTOP: the viewer must rotate 90 CW, which sends the LEFT edge to the
// TOP. So red belongs on top afterwards.
file_put_contents($rot, ccsig_test_exif_orientation($plain, 6));

$check = new Imagick($rot);
T::same(6, $check->getImageOrientation(), 'the fixture really does carry EXIF orientation 6');
$check->clear();

$rotOut = $tmp . '/rot-out.jpg';
ccsig_image_process($rot, $rotOut);

// Sample OFF-CENTRE. The centre column is the red/blue boundary in the
// unrotated image, so a centre sample is ambiguous either way — which is how
// the previous version got a passing assertion out of a blue-on-blue reading.
$probe  = new Imagick($rotOut);
$top    = $probe->getImagePixelColor(60, 30)->getColor();
$bottom = $probe->getImagePixelColor(60, CCSIG_AVATAR_PX - 30)->getColor();
$orient = $probe->getImageOrientation();
$probe->clear();

T::ok($top['r'] > 150 && $top['b'] < 100,
    sprintf('rotated: red is on TOP, got rgb(%d,%d,%d)', $top['r'], $top['g'], $top['b']));
T::ok($bottom['b'] > 150 && $bottom['r'] < 100,
    sprintf('rotated: blue is on the BOTTOM, got rgb(%d,%d,%d)', $bottom['r'], $bottom['g'], $bottom['b']));
T::ok(in_array($orient, [Imagick::ORIENTATION_UNDEFINED, Imagick::ORIENTATION_TOPLEFT], true),
    'and no orientation tag survives to rotate it a second time');

// ---------------------------------------------------------------------------
T::group('transparency flattens to white, not black');

$png = $tmp . '/t.png';
$t = new Imagick();
$t->newImage(400, 400, new ImagickPixel('transparent'));
$t->setImageFormat('png');
$t->writeImage($png);
$t->clear();

$flat = $tmp . '/flat.jpg';
ccsig_image_process($png, $flat);
$probe = new Imagick($flat);
$px = $probe->getImagePixelColor(4, 4)->getColor();
$probe->clear();
T::ok($px['r'] > 240 && $px['g'] > 240 && $px['b'] > 240,
    sprintf('a fully transparent PNG lands on white, got rgb(%d,%d,%d)', $px['r'], $px['g'], $px['b']));

// ---------------------------------------------------------------------------
T::group('rejected before any decode happens');

$cases = [
    'a text file named .jpg' => static function () use ($tmp) {
        $f = $tmp . '/fake.jpg';
        file_put_contents($f, str_repeat('not an image at all. ', 100));
        return $f;
    },
    'an over-wide image' => static function () use ($tmp) {
        $f = $tmp . '/wide.png';
        $im = new Imagick();
        $im->newImage(9000, 100, new ImagickPixel('white'));
        $im->setImageFormat('png');
        $im->writeImage($f);
        $im->clear();
        return $f;
    },
    'an empty file' => static function () use ($tmp) {
        $f = $tmp . '/empty.jpg';
        file_put_contents($f, '');
        return $f;
    },
];

foreach ($cases as $what => $make) {
    $f = $make();
    $threw = false;
    try {
        ccsig_image_process($f, $tmp . '/never.jpg');
    } catch (CcsigImageError $e) {
        $threw = true;
    }
    T::ok($threw, "refused: {$what}");
}

// A GIF is a real image and a valid file — it is simply not on the allow-list,
// which is the check that keeps SVG out.
$gif = $tmp . '/x.gif';
$g = new Imagick();
$g->newImage(100, 100, new ImagickPixel('white'));
$g->setImageFormat('gif');
$g->writeImage($gif);
$g->clear();
$threw = false;
try {
    ccsig_image_process($gif, $tmp . '/never2.jpg');
} catch (CcsigImageError $e) {
    $threw = true;
}
T::ok($threw, 'refused: a valid image whose type is not on the allow-list');

// ---------------------------------------------------------------------------
T::group('library limits are set, not merely assumed');

ccsig_image_limits();
T::ok(Imagick::getResourceLimit(Imagick::RESOURCETYPE_MEMORY) <= CCSIG_IM_MEMORY,
    'RESOURCETYPE_MEMORY is capped well under the container');
T::ok(Imagick::getResourceLimit(Imagick::RESOURCETYPE_AREA) <= CCSIG_IM_AREA,
    'RESOURCETYPE_AREA is capped');
