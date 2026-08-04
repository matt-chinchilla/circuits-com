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
function sig_contact_rows(array $person, string $mailbox): array
{
    $rows = [];

    $phone = trim((string) ($person['phone'] ?? ''));
    if ($phone !== '') {
        $href   = trim((string) ($person['phone_href'] ?? '')) ?: sig_tel_href($phone);
        $rows[] = ['Mobile', sig_link($href, $phone)];
    }

    $site = trim((string) ($person['website'] ?? ''));
    if ($site !== '') {
        $href   = trim((string) ($person['website_href'] ?? '')) ?: sig_web_href($site);
        $rows[] = ['Website', sig_link($href, $site)];
    }

    // The published address, which is not always the mailbox — see the roster.
    $email = trim((string) ($person['email'] ?? '')) ?: $mailbox;
    if ($email !== '') {
        $rows[] = ['Email', sig_link('mailto:' . $email, $email)];
    }

    $links = [];
    foreach ((array) ($person['socials'] ?? []) as $label => $url) {
        $label = trim((string) $label);
        $url   = trim((string) $url);
        if ($label !== '' && sig_safe_url($url, ['http', 'https']) !== '') {
            $links[] = sig_link($url, $label);
        }
    }
    if ($links) {
        // &middot; as an entity, not the glyph: non-ASCII characters in source
        // get mangled to escape literals by some editors in this repo.
        $sep    = '<span style="color:' . SIG_LABEL . ';">&nbsp;&middot;&nbsp;</span>';
        $rows[] = ['Links', implode($sep, $links)];
    }

    return $rows;
}

/** The grid itself. Returns '' when there is nothing to put in it. */
function sig_contact_grid(array $rows): string
{
    if (!$rows) {
        return '';
    }

    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">'];

    $last = count($rows) - 1;
    foreach ($rows as $i => [$label, $value]) {
        // 10px of air above the first row separates the grid from the title.
        $top    = $i === 0 ? 10 : 0;
        $bottom = $i === $last ? 0 : 5;

        $out[] = '<tr>';
        $out[] = '<td valign="top" style="padding:' . $top . 'px 14px ' . $bottom . 'px 0;'
            . 'font-family:' . SIG_MONO . ';font-size:10px;line-height:17px;letter-spacing:0.6px;'
            . 'color:' . SIG_LABEL . ';white-space:nowrap;mso-line-height-rule:exactly;">'
            . sig_esc(strtoupper($label)) . '</td>';
        $out[] = '<td valign="top" style="padding:' . $top . 'px 0 ' . $bottom . 'px 0;'
            . 'font-family:' . SIG_SANS . ';font-size:13px;line-height:17px;'
            . 'color:' . SIG_INK . ';mso-line-height-rule:exactly;">' . $value . '</td>';
        $out[] = '</tr>';
    }

    $out[] = '</table>';

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

    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">', '<tr>'];

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

    $out[] = '<td valign="top">' . implode('', $lines) . '</td>';
    $out[] = '</tr></table>';

    return implode('', $out);
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
 *     |          | | | MOBILE   (631) 560-9048        |
 *     |          | | | WEBSITE  matthew-chirichella…  |
 *     +----------+---+--------------------------------+
 *     ------------------------------------------------   hairline
 *     [mark] Circuit Center
 *            circuitcenter.ai . Electronic components…
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

    $out = ['<table border="0" cellpadding="0" cellspacing="0" role="presentation"'
        . ' style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;'
        . 'max-width:520px;font-family:' . SIG_SANS . ';'
        . '-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">'];

    $columns = 1; // the company band alone

    if ($name !== '') {
        $columns = $headshot !== '' ? 3 : 2;

        $out[] = '<tr>';

        if ($headshot !== '') {
            // Rendered at 72; the roster asks for a 144px source so it is not
            // soft on a 2x screen. alt is empty for the same reason as the
            // company mark: the name is right beside it. border-radius makes
            // it a circle everywhere except Outlook/Word, which renders the
            // square the file is — so crop the source square and it reads
            // correctly either way.
            $out[] = '<td width="72" valign="top" style="padding:0 16px 16px 0;">'
                . '<img src="' . sig_esc($headshot) . '" width="72" height="72" alt="" border="0"'
                . ' style="display:block;width:72px;height:72px;border:0;outline:none;'
                . 'text-decoration:none;border-radius:36px;"></td>';
        }

        // The spine. font-size:0 keeps the &nbsp; from adding width — the cell
        // has to hold SOMETHING because Word collapses a truly empty one.
        $out[] = '<td width="3" valign="top" bgcolor="' . SIG_SPINE . '"'
            . ' style="width:3px;min-width:3px;background-color:' . SIG_SPINE . ';'
            . 'font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>';

        $body = ['<div style="font-family:' . SIG_SANS . ';font-size:17px;line-height:22px;'
            . 'font-weight:700;letter-spacing:-0.2px;color:' . SIG_INK . ';'
            . 'mso-line-height-rule:exactly;">' . sig_esc($name) . '</div>'];

        if ($title !== '') {
            $body[] = '<div style="font-family:' . SIG_SANS . ';font-size:13px;line-height:18px;'
                . 'color:' . SIG_INK_SOFT . ';padding-top:2px;mso-line-height-rule:exactly;">'
                . sig_esc($title) . '</div>';
        }

        $body[] = sig_contact_grid(sig_contact_rows($person, $mailbox));

        $out[] = '<td valign="top" style="padding:0 0 16px 14px;">' . implode('', $body) . '</td>';
        $out[] = '</tr>';

        // Hairline. Same font-size:0 trick, so it is 1px and not a text line.
        $out[] = '<tr><td colspan="' . $columns . '" height="1" bgcolor="' . SIG_RULE . '"'
            . ' style="height:1px;line-height:1px;font-size:0;background-color:' . SIG_RULE
            . ';mso-line-height-rule:exactly;">&nbsp;</td></tr>';
    }

    $pad = $name !== '' ? ' style="padding-top:14px;"' : '';
    $out[] = '<tr><td colspan="' . $columns . '"' . $pad . '>' . sig_company_band($company)
        . '</td></tr>';
    $out[] = '</table>';

    return implode("\n", $out);
}
