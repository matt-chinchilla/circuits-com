<?php
/**
 * THE TEMPLATE — turns one row of signature-roster.php into email HTML.
 *
 * Pure functions, no I/O, no database. Require it and call sig_build().
 * seed-signatures.php uses it to install; preview-signatures.php uses it to
 * print. Both get byte-identical output, so what you preview is what is
 * stored.
 *
 * =====================================================================
 * WHY THIS LOOKS LIKE 1999 HTML
 * Email HTML is not web HTML. Outlook for Windows renders mail through
 * WORD's layout engine, not a browser engine, and Gmail rewrites the
 * document before showing it. So:
 *
 *   TABLES, not flexbox or grid.  Word has no flex, no grid, no calc(),
 *       and no CSS custom properties. Nested tables with explicit widths
 *       are the only layout primitive every client agrees on.
 *   INLINE styles, not classes.  Gmail strips <style> blocks outright, so
 *       a class-based signature arrives unstyled for a large share of
 *       recipients. Every declaration below is therefore on the element.
 *       This also means no @media queries and no dark-mode stylesheet —
 *       the design has to survive dark mode by construction instead.
 *   ABSOLUTE https IMAGE URLS.  Gmail and Outlook both block data: URIs,
 *       so nothing can be embedded; images must be hosted and reachable.
 *   NO WEB FONTS.  Only the OS-native stacks below, with Arial and
 *       Helvetica as the fallbacks that actually exist everywhere. Word
 *       walks the font list and takes the first name it recognises, which
 *       on Windows is 'Segoe UI'; the Apple names it skips harmlessly.
 *   UNDER 600px.  Many clients render mail in a narrow column. This table
 *       is shrink-to-fit — no width attribute at all — so it is as wide as
 *       its longest line (~380px) and can never force a sideways scroll.
 *       max-width is a belt for clients that honour it; Word ignores it,
 *       which does not matter because nothing here is wide.
 *   UPPERCASE IS TYPED, NOT STYLED.  Word does not implement
 *       text-transform, so the labels are upper-cased in PHP.
 *
 * =====================================================================
 * DARK MODE, AND WHY THERE IS NO BACKGROUND COLOUR
 * Apple Mail, Outlook.com and the Gmail apps all darken a message in dark
 * mode. Left to themselves they also invert the TEXT colours along with
 * the surface, so dark text stays legible. That co-operation only holds
 * while a block does not declare its own background: paint the signature
 * white and a client that darkens everything around it leaves a glaring
 * white card, while one that inverts the card but not the images breaks
 * the pairing between them.
 *
 * There is also no colour that solves it by hand. Body text needs 4.5:1
 * against white (luminance <= 0.183) AND 4.5:1 against a typical dark
 * surface such as #202124 (luminance >= 0.146 by the same formula) — the
 * two windows do not overlap, so no fixed ink is readable both ways. The
 * only correct move is to let the client do the inversion.
 *
 * So: NO background is declared anywhere in this signature. The two things
 * that cannot be inverted safely are handled instead —
 *   - the company mark is a FULL-BLEED dark tile (a PNG whose own pixels
 *     supply the glyph's background), so its contrast is baked into the
 *     file. Clients never invert image content. Measured off the PNG's own
 *     pixels: the glyph sits on its tile at 16.61:1 no matter what happens
 *     around it. On white the tile itself reads at 16.61:1; on a #202124
 *     dark surface the tile edge melts into the background (1.03:1) but the
 *     white glyph still reads against that surface at 16.10:1 and the green
 *     at 6.54:1. A transparent-background mark would have been
 *     invisible on one side or the other — that is why the tile was
 *     picked. Losing a silhouette is cosmetic; losing a glyph is not.
 *   - the 3px brand spine is the one declared background, and its colour
 *     was chosen to clear 3:1 as non-text on BOTH surfaces (see below).
 *
 * =====================================================================
 * COLOUR + MEASURED CONTRAST (WCAG 2.x relative luminance)
 * Ratios are against #ffffff, which is the light case and the one the ink
 * has to pass; the dark case is the client's inversion, above. Recompute
 * and update the number here if you change a value — do not eyeball it.
 */

if (!defined('SIG_ACCENT')) {

    /** Ink. #1a1f23 is the same charcoal as the tile in the logo mark. */
    define('SIG_INK',      '#1a1f23'); // 16.61:1 on #ffffff — name, values
    define('SIG_INK_SOFT', '#3d474c'); //  9.53:1 — job title
    define('SIG_LABEL',    '#5c666b'); //  5.89:1 — 10px mono label column, clears AA at small size
    /**
     * Links. This is the site's $executive-blue (the PCB dark green). The
     * bright brand green $nav-blue #44bd13 is only 2.46:1 on white and is
     * never used for text anywhere in this project for exactly that reason.
     */
    define('SIG_ACCENT',   '#0a4a2e'); // 10.34:1 — every link

    /**
     * The spine: a 3px vertical rule, the only declared background here.
     * #2e8b1a is $nav-blue walked down until it clears 3:1 as non-text
     * content against BOTH ends of the range — 4.35:1 on #ffffff and
     * 3.70:1 on a #202124 dark surface. The brand green itself fails the
     * light side (2.46:1), and the dark green SIG_ACCENT fails the dark
     * side (1.56:1); this is the value that survives whatever the client
     * decides to do.
     */
    define('SIG_SPINE',    '#2e8b1a');

    /** Hairline between the person and the company band. Decorative. */
    define('SIG_RULE',     '#dfe4e7');

    /**
     * The contact pills and the panel the QR sits in.
     *
     * A very slightly green-cast neutral rather than a pure grey: the whole
     * palette here is built around one green, and a neutral with no cast beside
     * it reads as a different design's leftover. Both are backgrounds only —
     * nothing is asked to carry text contrast except the ink on top of them,
     * which is SIG_INK at better than 15:1.
     */
    define('SIG_PILL_BG',   '#f4f7f6');
    define('SIG_PILL_EDGE', '#e2e9e5');

    /**
     * Type. Arial/Helvetica are appended to the site's native stacks
     * because a signature lands on machines the site never has to run on.
     * Word resolves the mono stack to Consolas.
     */
    define('SIG_SANS', "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif");
    define('SIG_MONO', "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sig_esc(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * Scheme allow-list for anything that reaches an href or a src.
 *
 * The roster is hand-edited, so this is not defending against an attacker so
 * much as against a paste accident — but the site has the same guard on
 * sponsor links (@shared/utils/url safeHttpUrl) for a stored-XSS reason, and a
 * signature is republished to every recipient, so it gets the same treatment.
 * Returns '' for anything not allowed, and every caller treats '' as "render
 * the text, drop the link".
 */
function sig_safe_url(string $url, array $schemes = ['http', 'https', 'mailto', 'tel']): string
{
    $url = trim($url);
    if ($url === '' || !preg_match('~^([a-z][a-z0-9+.\-]*):~i', $url, $m)) {
        return '';
    }

    return in_array(strtolower($m[1]), $schemes, true) ? $url : '';
}

/**
 * 'matthew-chirichella.com' -> 'https://matthew-chirichella.com'.
 *
 * Anything that ALREADY carries a scheme, by the RFC-3986 grammar, is returned
 * untouched so that sig_safe_url gets to judge it. That ordering is the whole
 * point: a bare 'javascript:alert(1)' pasted into the roster has no '://', so a
 * naive "does it start with http?" test would happily prepend https:// and emit
 * the nonsense link https://javascript:alert(1). Handing it back schemed
 * instead means the allow-list rejects it and the template prints the text with
 * no link at all.
 *
 * The trade: 'example.com:8080/x' is also legal scheme syntax ('example.com'),
 * so it is read as schemed, rejected, and printed unlinked. A host:port website
 * is not a thing anyone puts in a signature, and the failure is silent-but-safe
 * rather than wrong — set 'website_href' explicitly if you ever need one.
 */
function sig_web_href(string $site): string
{
    $site = trim($site);
    if ($site === '' || preg_match('~^[a-z][a-z0-9+.\-]*:~i', $site)) {
        return $site;
    }
    if (str_starts_with($site, '//')) {
        return 'https:' . $site;
    }

    return 'https://' . $site;
}

/**
 * '(631) 560-9048' -> 'tel:+16315609048'.
 *
 * A number already written with a leading '+' is taken at its word and simply
 * stripped of punctuation, so '+44 20 7946 0958' dials correctly. Without a
 * '+', only the two unambiguous US shapes are inferred — ten digits, or eleven
 * beginning with 1. Anything else (a seven-digit local number, an extension, a
 * bare international string) has no reading this function can be sure of, so it
 * returns '' and the template prints the number WITHOUT linking it rather than
 * dial somewhere wrong. Set 'phone_href' in the roster for those.
 *
 * (The eleven-digit branch is the same leading-1 trap the site's phone
 * formatter documents: dropping it turns +1 (800) 555-0142 into a wrong
 * number.)
 */
function sig_tel_href(string $phone): string
{
    $phone  = trim($phone);
    $digits = preg_replace('/\D+/', '', $phone) ?? '';

    if ($digits === '') {
        return '';
    }
    if (str_starts_with($phone, '+')) {
        return 'tel:+' . $digits;
    }
    if (strlen($digits) === 11 && $digits[0] === '1') {
        return 'tel:+' . $digits;
    }
    if (strlen($digits) === 10) {
        return 'tel:+1' . $digits;
    }

    return '';
}

/** A link, or just the text when the URL is missing or not allowed. */
function sig_link(string $href, string $text): string
{
    $safe = sig_safe_url($href);
    if ($safe === '') {
        return sig_esc($text);
    }

    return '<a href="' . sig_esc($safe) . '" style="color:' . SIG_ACCENT
        . ';text-decoration:none;">' . sig_esc($text) . '</a>';
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

/**
 * The label/value grid, assembled from whatever the person actually has.
 *
 * This is where graceful degradation lives: a row only exists if its value
 * does, so an absent phone number removes the word "Mobile" with it. Adding a
 * new kind of row — an office line, a booking link — is one more entry here
 * and the alignment absorbs it.
 *
 * @return array<int, array{0:string, 1:string}> [LABEL, value HTML]
 */
/**
 * One icon chip.
 *
 * WHY A PLATE AND NOT A BARE GLYPH. A monochrome glyph on transparency
 * disappears the instant a client renders it on a dark background, which is
 * why this file carried text labels for its whole first life. Each PNG bakes
 * in its own light plate, so the icon brings its own ground and an inverting
 * client cannot erase it.
 *
 * WHY ALT TEXT IS NEVER EMPTY HERE. Most clients block remote images by
 * default. When they do, `alt` is all that survives — so it carries the exact
 * word the mono label used to print ("Mobile", "GitHub"). Images off degrades
 * to the previous design rather than to a row of broken boxes. This is the
 * opposite of the company mark, whose alt is empty precisely because the name
 * is printed beside it.
 *
 * Returns '' when the icon base is unset, which is what makes the caller's
 * text fallback reachable — a deployment that has not shipped the images
 * shows labels rather than seven broken boxes.
 */
function sig_chip(string $base, string $name, string $alt, int $size): string
{
    $base = rtrim(trim($base), '/');
    if ($base === '' || !preg_match('/^[a-z][a-z0-9-]*$/', $name)) {
        return '';
    }
    $src = sig_safe_url($base . '/icon-' . $name . '.png', ['http', 'https']);
    if ($src === '') {
        return '';
    }

    return '<img src="' . sig_esc($src) . '" width="' . $size . '" height="' . $size . '"'
        . ' alt="' . sig_esc($alt) . '" border="0" style="display:block;width:' . $size
        . 'px;height:' . $size . 'px;border:0;outline:none;text-decoration:none;">';
}

/**
 * A plateless glyph, for use inside a pill. See sig_chip for why the two
 * variants exist and why neither can be substituted for the other.
 */
function sig_glyph(string $base, string $name, string $alt, int $size): string
{
    $base = rtrim(trim($base), '/');
    if ($base === '' || !preg_match('/^[a-z][a-z0-9-]*$/', $name)) {
        return '';
    }
    $src = sig_safe_url($base . '/glyph-' . $name . '.png', ['http', 'https']);
    if ($src === '') {
        return '';
    }

    return '<img src="' . sig_esc($src) . '" width="' . $size . '" height="' . $size . '"'
        . ' alt="' . sig_esc($alt) . '" border="0" style="display:block;width:' . $size
        . 'px;height:' . $size . 'px;border:0;outline:none;text-decoration:none;">';
}

/**
 * One contact pill: a rounded, tinted capsule holding a glyph and a value.
 *
 * Each pill is its OWN table in its own row rather than a row of a shared
 * table, which is what makes them shrink to fit their contents and come out
 * different widths. A shared table would column-align them to the widest, and
 * three equal-width capsules read as a table with the borders drawn on.
 *
 * border-radius is ignored by Outlook and Word, which render a square-cornered
 * tinted box. That degrades honestly — it still reads as a contained field,
 * which is why the tint carries the design here and the radius only sharpens
 * it.
 */
function sig_pill(string $glyph, string $value): string
{
    $inner = '<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr>';
    if ($glyph !== '') {
        $inner .= '<td width="16" valign="middle" style="width:16px;padding:0 9px 0 0;'
            . 'font-size:0;line-height:0;mso-line-height-rule:exactly;">' . $glyph . '</td>';
    }
    $inner .= '<td valign="middle" style="font-family:' . SIG_SANS . ';font-size:13px;'
        . 'line-height:18px;color:' . SIG_INK . ';white-space:nowrap;'
        . 'mso-line-height-rule:exactly;">' . $value . '</td>';
    $inner .= '</tr></table>';

    return '<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">'
        . '<tr><td bgcolor="' . SIG_PILL_BG . '" style="background-color:' . SIG_PILL_BG
        . ';border:1px solid ' . SIG_PILL_EDGE . ';border-radius:999px;padding:8px 16px;">'
        . $inner . '</td></tr></table>';
}

/**
 * Contact rows as [label, icon-name, value-html].
 *
 * The label survives alongside the icon name because it is not decoration:
 * it is the alt text, and it is the whole rendering when no icons are
 * configured.
 */
function sig_contact_rows(array $person, string $mailbox): array
{
    $rows = [];

    $phone = trim((string) ($person['phone'] ?? ''));
    if ($phone !== '') {
        $href   = trim((string) ($person['phone_href'] ?? '')) ?: sig_tel_href($phone);
        $rows[] = ['Mobile', 'phone', sig_link($href, $phone)];
    }

    // The published address, which does not have to be the mailbox — see the
    // roster. Ordered above the website deliberately: it is the one line a
    // reader is most likely to be looking for.
    $email = trim((string) ($person['email'] ?? '')) ?: $mailbox;
    if ($email !== '') {
        $rows[] = ['Email', 'email', sig_link('mailto:' . $email, $email)];
    }

    $site = trim((string) ($person['website'] ?? ''));
    if ($site !== '') {
        $href   = trim((string) ($person['website_href'] ?? '')) ?: sig_web_href($site);
        $rows[] = ['Website', 'website', sig_link($href, $site)];
    }

    return $rows;
}

/**
 * The stack of contact pills. Returns '' when there is nothing to put in it.
 *
 * Falls back to the original two-column grid — 10px mono label, then value —
 * when the images are not configured. That fallback is not decoration either:
 * it is what the signature looked like before the icons existed, and it is
 * what ships if the assets are ever unreachable.
 */
function sig_contact_grid(array $rows, string $iconBase): string
{
    if (!$rows) {
        return '';
    }

    $last = count($rows) - 1;

    if ($iconBase === '') {
        $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
            . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">'];
        foreach ($rows as $i => [$label, , $value]) {
            $top    = $i === 0 ? 10 : 0;
            $bottom = $i === $last ? 0 : 5;
            $out[]  = '<tr><td valign="top" style="padding:' . $top . 'px 14px ' . $bottom . 'px 0;'
                . 'font-family:' . SIG_MONO . ';font-size:10px;line-height:17px;letter-spacing:0.6px;'
                . 'color:' . SIG_LABEL . ';white-space:nowrap;mso-line-height-rule:exactly;">'
                . sig_esc(strtoupper($label)) . '</td>'
                . '<td valign="top" style="padding:' . $top . 'px 0 ' . $bottom . 'px 0;'
                . 'font-family:' . SIG_SANS . ';font-size:13px;line-height:17px;'
                . 'color:' . SIG_INK . ';mso-line-height-rule:exactly;">' . $value . '</td></tr>';
        }
        $out[] = '</table>';

        return implode('', $out);
    }

    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">'];
    foreach ($rows as $i => [$label, $icon, $value]) {
        $bottom = $i === $last ? 0 : 7;
        $out[]  = '<tr><td style="padding:0 0 ' . $bottom . 'px 0;">'
            . sig_pill(sig_glyph($iconBase, $icon, $label, 16), $value) . '</td></tr>';
    }
    $out[] = '</table>';

    return implode('', $out);
}

/**
 * The social row: one linked chip per network, or text links when the icons
 * are not configured.
 *
 * A label with no matching icon file still renders — as a text link, in the
 * same row. That keeps the roster's promise that ANY label works ('Scholar',
 * 'Calendly', 'Bluesky'); adding an icon for one is an optimisation, not a
 * precondition for listing it.
 */
function sig_social_row(array $person, string $iconBase): string
{
    $chips = [];
    $texts = [];

    foreach ((array) ($person['socials'] ?? []) as $label => $url) {
        $label = trim((string) $label);
        $url   = trim((string) $url);
        if ($label === '' || sig_safe_url($url, ['http', 'https']) === '') {
            continue;
        }
        $chip = sig_chip($iconBase, strtolower($label), $label, 30);
        if ($chip !== '') {
            $chips[] = '<td valign="middle" style="padding:0 8px 0 0;font-size:0;line-height:0;'
                . 'mso-line-height-rule:exactly;"><a href="' . sig_esc($url)
                . '" style="text-decoration:none;">' . $chip . '</a></td>';
        } else {
            $texts[] = sig_link($url, $label);
        }
    }

    if (!$chips && !$texts) {
        return '';
    }

    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
        . 'margin-top:14px;"><tr>'];
    $out = array_merge($out, $chips);

    if ($texts) {
        // &middot; as an entity, not the glyph: non-ASCII characters in source
        // get mangled to escape literals by some editors in this repo.
        $sep   = '<span style="color:' . SIG_LABEL . ';">&nbsp;&middot;&nbsp;</span>';
        $out[] = '<td valign="middle" style="font-family:' . SIG_SANS . ';font-size:12px;'
            . 'line-height:17px;color:' . SIG_INK . ';mso-line-height-rule:exactly;">'
            . implode($sep, $texts) . '</td>';
    }

    $out[] = '</tr></table>';

    return implode('', $out);
}

/**
 * The company band. Always present — it is the part that says which company
 * this is, and it is the whole signature for a mailbox that is not a person.
 */
function sig_company_band(array $company): string
{
    $name    = trim((string) ($company['name'] ?? ''));
    $url     = sig_safe_url(sig_web_href((string) ($company['url'] ?? '')), ['http', 'https']);
    $label   = trim((string) ($company['label'] ?? '')) ?: $url;
    $tagline = trim((string) ($company['tagline'] ?? ''));
    $mark    = sig_safe_url((string) ($company['mark'] ?? ''), ['http', 'https']);
    $size    = (int) ($company['mark_size'] ?? 40);
    $qr      = sig_safe_url((string) ($company['qr'] ?? ''), ['http', 'https']);
    $qrSize  = (int) ($company['qr_size'] ?? 112);

    // width:100% only when there is a QR to push to the far edge. Without one
    // the band must stay shrink-to-fit, or the company name is left stranded
    // against a full-width row it does not fill.
    $wide = $qr !== '' ? 'width:100%;' : '';
    $out  = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
        . $wide . '">', '<tr>'];

    if ($mark !== '') {
        // alt is EMPTY on purpose. The company name is printed immediately to
        // the right of this image, so when a client blocks images (most do by
        // default) alt text here would say the same words twice. An image that
        // duplicates adjacent text is decorative by definition.
        //
        // border-radius rounds the tile in Apple Mail, iOS and the webmail
        // clients; Word ignores it and renders the square the file actually
        // is, which still reads as a deliberate mark.
        $out[] = '<td width="' . $size . '" valign="top" style="padding:0 12px 0 0;">'
            . '<img src="' . sig_esc($mark) . '" width="' . $size . '" height="' . $size . '"'
            . ' alt="" border="0" style="display:block;width:' . $size . 'px;height:' . $size
            . 'px;border:0;outline:none;text-decoration:none;border-radius:9px;"></td>';
    }

    $lines = [];
    if ($name !== '') {
        $lines[] = '<div style="font-family:' . SIG_SANS . ';font-size:13px;line-height:18px;'
            . 'font-weight:700;color:' . SIG_INK . ';mso-line-height-rule:exactly;">'
            . sig_esc($name) . '</div>';
    }

    $second = [];
    if ($url !== '' && $label !== '') {
        $second[] = sig_link($url, $label);
    }
    if ($tagline !== '') {
        $second[] = sig_esc($tagline);
    }
    if ($second) {
        $sep      = '<span style="color:' . SIG_LABEL . ';">&nbsp;&middot;&nbsp;</span>';
        $lines[]  = '<div style="font-family:' . SIG_SANS . ';font-size:12px;line-height:17px;'
            . 'color:' . SIG_LABEL . ';padding-top:2px;mso-line-height-rule:exactly;">'
            . implode($sep, $second) . '</div>';
    }

    $out[] = '<td valign="middle">' . implode('', $lines) . '</td>';
    $out[] = '</tr></table>';

    return implode('', $out);
}

/**
 * The QR in its tinted panel.
 *
 * The panel is the one element carried over from the reference design that
 * survives every client: it is a background colour on a table cell. The
 * reference's outer white card is not here on purpose — a white card on the
 * white background a signature actually lands on is invisible without a
 * border, and Outlook squares the radius and drops the shadow, so it would
 * cost a rectangle and buy nothing.
 *
 * qr_size is a FLOOR. The code was decoded back at every size it might render
 * at and stops resolving below 112px, so shrinking this to fit a layout
 * produces something shaped like a QR code that no phone will read.
 */
function sig_qr_panel(array $company): string
{
    $qr = sig_safe_url((string) ($company['qr'] ?? ''), ['http', 'https']);
    if ($qr === '') {
        return '';
    }
    $size = max(112, (int) ($company['qr_size'] ?? 220));
    $url  = trim((string) ($company['label'] ?? '')) ?: 'our site';
    $pad  = 16;

    return '<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
        . 'height:100%;">'
        . '<tr><td bgcolor="' . SIG_PILL_BG . '" align="center" valign="middle"'
        . ' style="background-color:' . SIG_PILL_BG
        . ';border:1px solid ' . SIG_PILL_EDGE . ';border-radius:16px;padding:' . $pad . 'px;'
        . 'font-size:0;line-height:0;mso-line-height-rule:exactly;">'
        // alt is a sentence, not "QR code": with images blocked the reader
        // needs to know where it would have taken them, and the destination is
        // the only useful part of that.
        . '<img src="' . sig_esc($qr) . '" width="' . $size . '" height="' . $size . '"'
        . ' alt="Scan for ' . sig_esc($url) . '" border="0" style="display:block;width:'
        . $size . 'px;height:' . $size . 'px;border:0;outline:none;text-decoration:none;'
        . '"></td></tr></table>';
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/**
 * Build one signature.
 *
 * Layout, when the person has everything:
 *
 *     +----------+---+--------------------------------+
 *     | headshot | | | Matthew Chirichella            |
 *     |  72x72   | | | Data Scientist                 |
 *     |          | | | (o)  (631) 560-9048            |
 *     |          | | | (o)  matthew-chirichella.com   |
 *     |          | | | [gh][li][ig][x]                |
 *     +----------+---+--------------------------------+
 *     ------------------------------------------------   hairline
 *     [mark] Circuit Center                    +------+
 *            circuitcenter.ai . Electronic…    |  QR  |
 *                                              +------+
 *
 * The QR sits in the COMPANY band rather than beside the contact grid, which
 * is where it looks most natural on a wide screen. That row is the narrowest
 * one here, and a 112px column added to the contact grid instead would leave
 * roughly 170px for the text on a 375px phone -- not enough for an email
 * address at 13px, so it would wrap mid-address on every mobile client.
 *
 * Everything above the hairline is optional. No headshot drops the left
 * column; no name drops the personal block entirely and leaves the company
 * band standing alone. The 3px spine is kept whenever there IS a personal
 * block, with or without a photograph, so the two shapes still read as the
 * same signature.
 *
 * @param string $mailbox the account this is installed into — also the
 *                        fallback for a person with no published address
 */
function sig_build(array $person, array $company, string $mailbox): string
{
    $name     = trim((string) ($person['name'] ?? ''));
    $title    = trim((string) ($person['title'] ?? ''));
    $headshot = sig_safe_url((string) ($person['headshot'] ?? ''), ['http', 'https']);
    $iconBase = (string) ($company['icons'] ?? '');

    // No person: the company band IS the signature. Unchanged, and the reason
    // that band still exists at all -- no-reply@ has no name, no photograph and
    // no pills, and still has to say which company is writing.
    if ($name === '') {
        return '<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
            . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
            . 'max-width:560px;font-family:' . SIG_SANS . ';'
            . '-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">'
            . '<tr><td>' . sig_company_band($company) . '</td></tr></table>';
    }

    // ---- left column: identity, pills, socials ----------------------------
    $ident = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr>'];

    if ($headshot !== '') {
        // Rendered at 72 from a 288px source. alt is empty for the same reason
        // as the company mark: the name is printed immediately beside it.
        // border-radius circles it everywhere except Outlook and Word, which
        // render the square the file actually is -- which is why the roster
        // insists the source is cropped square rather than pre-masked.
        $ident[] = '<td width="72" valign="middle" style="width:72px;padding:0 16px 0 0;'
            . 'font-size:0;line-height:0;mso-line-height-rule:exactly;">'
            . '<img src="' . sig_esc($headshot) . '" width="72" height="72" alt="" border="0"'
            . ' style="display:block;width:72px;height:72px;border:0;outline:none;'
            . 'text-decoration:none;border-radius:36px;"></td>';
    }

    $lines = ['<div style="font-family:' . SIG_SANS . ';font-size:21px;line-height:27px;'
        . 'font-weight:700;letter-spacing:-0.4px;color:' . SIG_INK . ';'
        . 'mso-line-height-rule:exactly;">' . sig_esc($name) . '</div>'];

    // "CEO & Founder at Circuit Center" on one line, the company linked. This
    // is what replaced the separate company band for a person: the band cost a
    // third horizontal register under an already two-column layout, and the
    // mark it carried is still present -- it is in the middle of the QR.
    $whoLine = $title !== '' ? sig_esc($title) : '';
    $coName  = trim((string) ($company['name'] ?? ''));
    $coUrl   = sig_safe_url(sig_web_href((string) ($company['url'] ?? '')), ['http', 'https']);
    if ($coName !== '') {
        $co = $coUrl !== '' ? sig_link($coUrl, $coName) : sig_esc($coName);
        $whoLine = $whoLine !== '' ? $whoLine . ' at ' . $co : $co;
    }
    if ($whoLine !== '') {
        $lines[] = '<div style="font-family:' . SIG_SANS . ';font-size:13px;line-height:19px;'
            . 'color:' . SIG_INK_SOFT . ';padding-top:3px;mso-line-height-rule:exactly;">'
            . $whoLine . '</div>';
    }

    $ident[] = '<td valign="middle">' . implode('', $lines) . '</td>';
    $ident[] = '</tr></table>';

    $left    = [implode('', $ident)];
    $pills   = sig_contact_grid(sig_contact_rows($person, $mailbox), $iconBase);
    $socials = sig_social_row($person, $iconBase);

    // Socials sit directly under the identity block, above the pills. They are
    // small, and up here they read as part of who this is; parked under the
    // pills they read as an afterthought at the bottom of a list.
    if ($socials !== '') {
        $left[] = $socials;
    }
    if ($pills !== '') {
        $left[] = '<div style="line-height:0;font-size:0;height:16px;">&nbsp;</div>' . $pills;
    }

    // ---- assemble ---------------------------------------------------------
    // max-width 560 rather than the reference's 816. A signature is scaled to
    // fit by mobile clients, so an 816px block on a 375px phone renders 13px
    // text at about 6px. 560 is the widest this composition goes without that.
    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
        . 'max-width:600px;font-family:' . SIG_SANS . ';'
        . '-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">',
        '<tr style="height:100%;">'];

    $out[] = '<td valign="top">' . implode('', $left) . '</td>';

    // Its own section, running the full height of the block rather than
    // floating beside it. height:100% on the cell is honoured by the webmail
    // and Apple clients; Word ignores it, and there the panel is simply as tall
    // as the QR plus its padding, which is within a few pixels of the same
    // thing because the QR is sized to the left column in the first place.
    $panel = sig_qr_panel($company);
    if ($panel !== '') {
        $out[] = '<td width="' . (max(112, (int) ($company['qr_size'] ?? 220)) + 34)
            . '" align="right" valign="top" style="padding:0 0 0 20px;height:100%;">'
            . $panel . '</td>';
    }

    $out[] = '</tr></table>';

    return implode("\n", $out);
}
