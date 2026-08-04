<?php
/**
 * Print signatures without touching anything.
 *
 * Runs anywhere PHP does — no database, no container, no mail box — because
 * the template is pure. Use it to look at a signature before installing it,
 * and to diff what a roster edit actually changed.
 *
 *   php preview-signatures.php                       every mailbox, as HTML fragments
 *   php preview-signatures.php matthew@circuitcenter.ai   just one
 *   php preview-signatures.php --page > /tmp/sig.html     a browsable page of all of them
 *
 * --page wraps the fragments in a minimal document so they can be opened in a
 * browser. That document is a VIEWER, not part of the signature: what gets
 * stored in Roundcube is only ever the fragment.
 */

require_once __DIR__ . '/signature-template.php';

$roster = require __DIR__ . '/signature-roster.php';

$args = array_slice($argv, 1);
$page = in_array('--page', $args, true);
$only = null;
foreach ($args as $arg) {
    if ($arg !== '--page') {
        $only = $arg;
    }
}

$people = $roster['people'];
if ($only !== null) {
    if (!isset($people[$only])) {
        fwrite(STDERR, "no such mailbox in the roster: {$only}\n");
        fwrite(STDERR, 'known: ' . implode(', ', array_keys($people)) . "\n");
        exit(1);
    }
    $people = [$only => $people[$only]];
}

if ($page) {
    echo "<!doctype html>\n<meta charset=\"utf-8\">\n<title>Signature preview</title>\n";
    // A neutral page background so it is obvious the signature declares none
    // of its own. Swap to #202124 to eyeball the dark case.
    echo "<body style=\"background:#ffffff;margin:0;padding:32px;font-family:sans-serif;\">\n";
}

foreach ($people as $mailbox => $person) {
    $html = sig_build($person, $roster['company'], $mailbox);

    if ($page) {
        echo '<p style="font:12px/1.4 monospace;color:#888;margin:28px 0 8px;">'
            . htmlspecialchars($mailbox, ENT_QUOTES, 'UTF-8') . ' &mdash; '
            . strlen($html) . " bytes</p>\n";
        echo $html . "\n<hr style=\"border:0;border-top:1px dashed #ccc;margin:28px 0;\">\n";
        continue;
    }

    echo "===== {$mailbox} (" . strlen($html) . " bytes) =====\n";
    echo $html . "\n\n";
}
