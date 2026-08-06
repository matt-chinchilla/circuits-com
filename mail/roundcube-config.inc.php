<?php
// Roundcube overrides for Circuit Center, appended AFTER the image's own
// generated config (which this file includes first, so nothing env-driven is
// lost). Mounted read-only over /var/www/html/config/config.inc.php.
//
// Two things live here that env vars cannot express:

// 1. Preserve everything the image generated from ROUNDCUBEMAIL_* env vars.
$config['plugins'] = [];
$config['log_driver'] = 'stdout';
$config['zipdownload_selection'] = true;
$config['enable_spellcheck'] = true;
$config['spellcheck_engine'] = 'pspell';
include(__DIR__ . '/config.docker.inc.php');

// 2. STARTTLS on the internal hop. docker-mailserver runs Dovecot with
//    `ssl = required`, so plaintext IMAP on 143 is refused outright — that is
//    what produced "Connection to storage server failed". `tls://` makes
//    Roundcube issue STARTTLS before authenticating.
$config['imap_host'] = 'tls://mailserver:143';
$config['smtp_host'] = 'tls://mailserver:587';

// The mail server's certificate is issued for mail.circuitcenter.ai, but we
// reach it here by its Docker service name, so the name will never match.
// Verification is disabled ONLY for this hop: the traffic is container-to-
// container on a private bridge network on one host and never touches a wire.
// Everything a human or another mail server talks to — 443 webmail, 993 IMAP,
// 587 submission, 25 SMTP — still presents and verifies the real certificate.
$ssl_no_verify = [
    'ssl' => [
        'verify_peer'       => false,
        'verify_peer_name'  => false,
        'allow_self_signed' => true,
    ],
];
$config['imap_conn_options'] = $ssl_no_verify;
$config['smtp_conn_options'] = $ssl_no_verify;

// 3. Logo. Elastic's templates hard-code a leading-slash src, which Roundcube
//    re-anchors into the template-owning skin (elastic), so a child-skin file
//    can never shadow it. `skin_logo` is the supported hook. Values must NOT
//    start with a slash, or they get re-anchored right back to Elastic's cube.
//
//    TWO keys, because there are two logo slots with two different shapes:
//
//    - login  : templates/login.html, sized by the skin to the 232x56 lockup.
//    - the app: the slot at the top of the task rail. That tag lives in
//      Elastic's templates/includes/menu.html, which is an INCLUDE --
//      rcmail_output_html sets template_name for the TOP-LEVEL template only,
//      so the logo object there reports the enclosing TASK template ('mail',
//      'addressbook', 'settings', ...), never 'menu'. A per-template key would
//      therefore have to enumerate every task and would silently miss any new
//      one, so this is the wildcard's job.
//
//    Order matters and is safe: get_template_logo (release 1.6, verified in
//    program/include/rcmail_output_html.php on this container) tries
//    'skin:template' BEFORE 'skin:*', so login keeps the wide lockup and
//    everything else falls through to the square badge.
//
//    Not affected, by construction: favicon/print/link are TYPED lookups that
//    only ever match bracket-suffixed keys ('[favicon]'), and the print
//    templates additionally pass logo-match="template", which strips wildcard
//    keys from the candidate list outright. Neither key can leak into them.
$config['skin_logo'] = [
    'circuitcenter:login' => 'skins/circuitcenter/images/logo.svg',
    // Glyph-only since the skin went dark (D1 Instrument Dark). The badge
    // variant's plate measures 1.03:1 on the new near-black rail header --
    // an invisible rounded square -- and no surface in this palette gives it
    // a usable fill. logo-badge.svg stays in the tree and becomes correct
    // again the moment that header is light. See the note in logo-mark.svg.
    'circuitcenter:*'     => 'skins/circuitcenter/images/logo-mark.svg',
];

// ---------------------------------------------------------------------------
// COMPOSE IN HTML BY DEFAULT — this is what makes the signature appear.
//
// Roundcube ships `htmleditor = 0`, meaning compose opens as PLAIN TEXT, and a
// plain-text compose cannot render an HTML signature. The identities were
// correct the whole time -- standard=1, html_signature=1, the markup stored --
// and the signature still did not show, because the editor it would have been
// inserted into does not do markup.
//
// 1 = always HTML. Not 4 ("always except when replying to plain text"), which
// looks tempting and is wrong here: it would drop the signature on exactly the
// replies most likely to go to a distributor's ticketing system.
//
// This is a DEFAULT, not a lock. It applies because no user has an htmleditor
// preference of their own; anyone who sets one in Settings keeps it.
$config['htmleditor'] = 1;

// Signature above the quoted text on a reply, rather than at the very bottom
// beneath the entire thread. Roundcube's default buries it after the quote.
$config['sig_above'] = true;

// Compose in the SAME face the signature declares, so a message is not two
// typefaces stacked on each other.
//
// This is not free text. rcmail_action::font_defs is a fixed list of 13 names
// and returns NULL for anything outside it, so the native OS stack the
// signature used to carry could never have been set here -- uniformity had to
// come from the signature's side, and it did. 'Helvetica' resolves to
// "Helvetica,Arial,sans-serif", which is character-for-character what
// SIG_SANS is now. Change one and change the other.
//
// The size already agreed by accident and is left alone: 10pt is about 13.3px
// against the signature's 13px body text.
$config['default_font'] = 'Helvetica';

// 12pt, up from Roundcube's 10pt. The signature's body text stays at 13px
// rather than being raised to match: 12pt is about 16px, so the message now
// reads slightly larger than the block signing it, which is the conventional
// hierarchy. Matching them exactly would make the signature compete with the
// message.
$config['default_font_size'] = '12pt';

// Give the compose editor an explicit ink colour.
//
// This REPLACES program/resources/tinymce/content.css rather than adding to
// it, which is why the skin's copy carries that file's blockquote and pre
// rules as well — see the header of styles/editor.css. Nothing in the stock
// chain set a text colour at all, so the editor rendered whatever the iframe
// defaulted to; this states it.
$config['editor_css_location'] = '/styles/editor.css';

// Remote images: allow from people you know, not from everyone.
//
//   0 - never, always ask          (the shipped default, and the prompt)
//   1 - allow from my contacts     <- this
//   2 - always allow
//   3 - trusted senders only
//
// 1 covers the actual complaint without opening the door: the team are seeded
// into each other's address books by seed-contacts.php, and collected_recipients
// and collected_senders are both on by default, so an address is trusted as
// soon as you have written to it — including your own, which is what makes a
// test message to yourself load its images.
//
// NOT 2. Roundcube fetches remote images straight from the sender's server
// with no proxy in front, so "always" would let any stranger's tracking pixel
// confirm the address is live and log the IP that opened it. That is the
// mechanism spam lists are built from, and it is not worth trading for the
// handful of prompts it would additionally suppress.
$config['show_images'] = 1;
