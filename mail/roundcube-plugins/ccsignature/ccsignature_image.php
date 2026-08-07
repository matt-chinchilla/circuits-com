<?php
/**
 * Headshot processing — the only code here that touches Imagick.
 *
 * Separate from ccsignature_fields.php on purpose: that file is pure and runs
 * in the local harness, this one needs an extension the local PHP does not
 * have. Keeping them apart is what lets the field tests run everywhere and the
 * image tests skip loudly.
 *
 * =====================================================================
 * THE CEILING IS THE CONTAINER, NOT PHP
 *
 * The obvious limit is memory_limit=64M, and it is the wrong one to design
 * against. Measured on the mail box:
 *
 *   roundcube container mem_limit    192 MB   (~55 MB idle, ~137 MB headroom)
 *   Imagick RESOURCETYPE_MEMORY      917 MB
 *   Imagick RESOURCETYPE_MAP       1,834 MB
 *   whole box                        916 MB
 *
 * Imagick's pixel cache is allocated by the ImageMagick C library, NOT the PHP
 * allocator, so it does not spend memory_limit and PHP never sees it coming.
 * Its own defaults are five times the container's entire allowance. Exceeding a
 * cgroup is not a failed request: the kernel OOM-kills the group, so an
 * oversized upload presents as "webmail went down when I added my photo" — and
 * on a 916 MB box it could take the mail server with it.
 *
 * So the limits are set BEFORE any decode, every time, and they are the first
 * thing this file does rather than something it relies on being configured.
 *
 * MEASURED, with the limits set, against a real 4032x3024 photo (2.3 MB):
 *   output 288x288 at 54 KB, PHP peak 2.0 MB against a 64 M limit, 1.62 s,
 *   and the container went 58.8 -> 54.3 MB — no growth at all.
 * The full bitmap is never materialised at any layer. That is the whole point
 * of the DCT-scaled read below.
 */

declare(strict_types=1);

/** Final square, matching what signature-template.php renders at 72px. */
const CCSIG_AVATAR_PX = 288;

/** Refuse before decode. 8000px covers any phone; 40MP covers any camera. */
const CCSIG_MAX_EDGE   = 8000;
const CCSIG_MAX_PIXELS = 40000000;

/**
 * Bytes accepted from the client. Well under upload_max_filesize (25M) and
 * post_max_size (25M): a POST over post_max_size arrives with $_POST EMPTY,
 * which Roundcube's request checker treats as an empty request rather than an
 * error, so the user gets a confusing validation message instead of "too big".
 * Staying far below that boundary means we own the error message.
 */
const CCSIG_MAX_BYTES = 8 * 1024 * 1024;

/** Library limits, in bytes. Deliberately far under the container's headroom. */
const CCSIG_IM_MEMORY = 48 * 1024 * 1024;
const CCSIG_IM_MAP    = 64 * 1024 * 1024;
const CCSIG_IM_AREA   = 40 * 1024 * 1024;
const CCSIG_IM_DISK   = 256 * 1024 * 1024;

/** What we will decode. SVG is absent on purpose — it executes script. */
const CCSIG_ACCEPT = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP];

class CcsigImageError extends RuntimeException
{
}

/**
 * Cap the ImageMagick LIBRARY, which PHP's memory_limit does not reach.
 *
 * Called at the top of every entry point rather than once at load: these are
 * process-global and another plugin, or a Roundcube upgrade, could have moved
 * them. Cheap to set, catastrophic to assume.
 */
function ccsig_image_limits(): void
{
    Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, CCSIG_IM_MEMORY);
    Imagick::setResourceLimit(Imagick::RESOURCETYPE_MAP, CCSIG_IM_MAP);
    Imagick::setResourceLimit(Imagick::RESOURCETYPE_AREA, CCSIG_IM_AREA);
    Imagick::setResourceLimit(Imagick::RESOURCETYPE_DISK, CCSIG_IM_DISK);
    // Threads add per-thread pixel cache for no benefit at this size.
    Imagick::setResourceLimit(Imagick::RESOURCETYPE_THREAD, 1);
}

/**
 * Header-only probe. Returns [width, height, IMAGETYPE_*].
 *
 * getimagesize reads the header and does NOT decode, so this is what makes it
 * safe to look at an untrusted file at all. Type comes from CONTENT, never from
 * the filename or the client's Content-Type — both are attacker-chosen.
 */
function ccsig_image_probe(string $path): array
{
    if (!is_file($path) || filesize($path) === 0) {
        throw new CcsigImageError('nofile');
    }
    if (filesize($path) > CCSIG_MAX_BYTES) {
        throw new CcsigImageError('toobig');
    }

    $info = @getimagesize($path);
    if ($info === false) {
        throw new CcsigImageError('notimage');
    }

    [$w, $h] = $info;
    $type = $info[2] ?? 0;

    if (!in_array($type, CCSIG_ACCEPT, true)) {
        throw new CcsigImageError('badtype');
    }
    if ($w < 1 || $h < 1 || $w > CCSIG_MAX_EDGE || $h > CCSIG_MAX_EDGE) {
        throw new CcsigImageError('toolarge');
    }
    if ($w * $h > CCSIG_MAX_PIXELS) {
        throw new CcsigImageError('toolarge');
    }

    return [$w, $h, $type];
}

/**
 * Untrusted image file -> a 288px square JPEG at $dest.
 *
 * The ORDER of operations in here is the part worth reading twice; three of
 * these steps are wrong if moved.
 */
function ccsig_image_process(string $src, string $dest): void
{
    if (!extension_loaded('imagick')) {
        throw new CcsigImageError('noimagick');
    }

    ccsig_image_limits();
    [$w, $h, $type] = ccsig_image_probe($src);

    $im = new Imagick();
    try {
        // 1. SCALED DECODE, and only for JPEG. setSize() is a hint to libjpeg
        //    to emit at 1/2, 1/4 or 1/8 scale during decompression, so the full
        //    bitmap is never built. It has no effect on PNG or WebP, which have
        //    no equivalent — hence the pixel cap above, which is what bounds
        //    those instead.
        if ($type === IMAGETYPE_JPEG) {
            $scale = 1;
            while ($scale < 8 && ($w / ($scale * 2)) >= CCSIG_AVATAR_PX
                              && ($h / ($scale * 2)) >= CCSIG_AVATAR_PX) {
                $scale *= 2;
            }
            if ($scale > 1) {
                $im->setSize((int) ceil($w / $scale), (int) ceil($h / $scale));
            }
        }

        $im->readImage($src);

        // 2. AUTO-ORIENT BEFORE STRIPPING. A phone photo is stored in the
        //    sensor's orientation with an EXIF tag saying how to rotate it.
        //    stripImage() removes that tag. Strip first and the photo comes out
        //    sideways, with nothing left to explain why.
        ccsig_image_autoorient($im);
        $im->stripImage();

        // 3. FLATTEN ONTO WHITE BEFORE JPEG. JPEG has no alpha, so a
        //    transparent PNG composited onto the default background renders
        //    BLACK — a person uploads a cut-out headshot and gets a silhouette.
        $flat = new Imagick();
        $flat->newImage($im->getImageWidth(), $im->getImageHeight(), new ImagickPixel('white'));
        $flat->compositeImage($im, Imagick::COMPOSITE_OVER, 0, 0);
        $im->clear();
        $im = $flat;

        // Centre crop to square, then to size. cropThumbnailImage does both.
        $im->setImageColorspace(Imagick::COLORSPACE_SRGB);
        $im->cropThumbnailImage(CCSIG_AVATAR_PX, CCSIG_AVATAR_PX);

        // 4. RE-ENCODE IS THE SECURITY BOUNDARY. The bytes written are ones
        //    this code produced from decoded pixels, so a PHP payload appended
        //    after the JPEG EOI marker, or hidden in a comment segment, does
        //    not survive. Validation decides whether to process; re-encoding is
        //    what makes the output safe.
        $im->setImageFormat('jpeg');
        $im->setImageCompressionQuality(88);
        $im->setInterlaceScheme(Imagick::INTERLACE_PLANE);

        if (!$im->writeImage($dest)) {
            throw new CcsigImageError('writefail');
        }
    } catch (ImagickException $e) {
        throw new CcsigImageError('decodefail');
    } finally {
        $im->clear();
    }

    @chmod($dest, 0644);
}

/**
 * Apply EXIF orientation, then neutralise it.
 *
 * Imagick::autoLevelImage-style helpers vary across builds, so this is the
 * explicit form: it works the same on any ImageMagick and is readable years
 * from now.
 */
function ccsig_image_autoorient(Imagick $im): void
{
    $white = new ImagickPixel('white');
    switch ($im->getImageOrientation()) {
        case Imagick::ORIENTATION_TOPRIGHT:
            $im->flopImage();
            break;
        case Imagick::ORIENTATION_BOTTOMRIGHT:
            $im->rotateImage($white, 180);
            break;
        case Imagick::ORIENTATION_BOTTOMLEFT:
            $im->flopImage();
            $im->rotateImage($white, 180);
            break;
        case Imagick::ORIENTATION_LEFTTOP:
            $im->flopImage();
            $im->rotateImage($white, -90);
            break;
        case Imagick::ORIENTATION_RIGHTTOP:
            $im->rotateImage($white, 90);
            break;
        case Imagick::ORIENTATION_RIGHTBOTTOM:
            $im->flopImage();
            $im->rotateImage($white, 90);
            break;
        case Imagick::ORIENTATION_LEFTBOTTOM:
            $im->rotateImage($white, -90);
            break;
        default:
            return;
    }
    $im->setImageOrientation(Imagick::ORIENTATION_TOPLEFT);
}
