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
