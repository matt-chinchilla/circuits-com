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

// 3. Logo. Elastic's login template hard-codes a leading-slash src, which
//    Roundcube re-anchors into the template-owning skin (elastic), so a
//    child-skin file can never shadow it. `skin_logo` is the supported hook.
//    The value must NOT start with a slash, or it gets re-anchored right back
//    to Elastic's cube.
$config['skin_logo'] = [
    'circuitcenter:login' => 'skins/circuitcenter/images/logo.svg',
];
