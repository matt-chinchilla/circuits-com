<?php
/**
 * Install the roster's signatures into Roundcube.
 *
 * Run it through seed-signatures.sh, which backs the database up and copies
 * this and its two dependencies into the container.
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO
 * On an identity that already exists it touches THREE columns and no others:
 * `signature`, `html_signature`, and `changed` (the row's own modification
 * stamp, which Roundcube maintains itself and which would otherwise lie). It
 * never renames an identity, never changes an address, never moves the default
 * identity, and never deletes anything. If a signature is already byte-for-byte
 * what the roster generates it does not write at all, so a re-run is genuinely
 * a no-op rather than a no-op-shaped UPDATE.
 *
 * WHY IT PRE-CREATES ROWS
 * Roundcube creates a user AND its first identity together, in
 * rcube_user::create(), on FIRST LOGIN. seed-contacts.php pre-creates the
 * `users` row so that a new hire's address book is populated before they ever
 * log in — but Roundcube only creates an identity alongside a user it created
 * ITSELF, so a pre-created user never gets one. On this install that has
 * already happened: daniel, anthony and ronald have all logged in, all have
 * user rows, and none of them has an identity at all. So this script creates
 * the missing identity as well as the missing user.
 *
 * That makes the (username, mail_host) pair load-bearing for exactly the reason
 * seed-contacts.php documents: it has to equal what Roundcube itself would
 * write, or login creates a SECOND user row and everything seeded against the
 * first — contacts and signature both — silently disappears. MAIL_HOST is
 * ROUNDCUBEMAIL_DEFAULT_HOST from docker-compose.webmail.yml, and login_lc=2
 * (Roundcube's default) lower-cases the username, which every address in the
 * roster already is.
 *
 * A NEW identity has to be given a name and an address, because there is no
 * prior value to preserve — see identity_name in the roster. It is only ever
 * made the default when the user has no other identity to demote.
 *
 * Usage (inside the roundcube container):
 *   php seed-signatures.php                     install
 *   php seed-signatures.php --dry-run           report what would change, write nothing
 *   php seed-signatures.php --fill-blank-names  additionally fill EMPTY identity
 *                                               names (see below)
 *
 * --fill-blank-names is opt-in because it writes outside the signature columns.
 * It only ever fills a name that is currently the empty string, so it cannot
 * overwrite something a person chose; it exists because an identity with no
 * display name sends mail as a bare address, and matthew's identity — created
 * by Roundcube before any of this existed — is in exactly that state.
 */

const DB_PATH   = '/var/roundcube/db/sqlite.db';
const MAIL_HOST = 'mailserver'; // must match ROUNDCUBEMAIL_DEFAULT_HOST

require_once __DIR__ . '/signature-template.php';

$options   = array_slice($argv, 1);
$dryRun    = in_array('--dry-run', $options, true);
$fillNames = in_array('--fill-blank-names', $options, true);

foreach ($options as $option) {
    if (!in_array($option, ['--dry-run', '--fill-blank-names'], true)) {
        fwrite(STDERR, "unknown option: {$option}\n");
        exit(2);
    }
}

$roster = require __DIR__ . '/signature-roster.php';

/**
 * Find the user row Roundcube would find, or make the one it would make.
 * Deliberately identical to seed-contacts.php's version — the two scripts must
 * agree on what a user IS or they will seed different rows.
 */
function findOrCreateUser(PDO $db, string $mailbox, bool $dryRun, array &$report): ?int
{
    $find = $db->prepare('SELECT user_id FROM users WHERE username = ? AND mail_host = ?');
    $find->execute([$mailbox, MAIL_HOST]);
    $existing = $find->fetchColumn();

    if ($existing !== false) {
        return (int) $existing;
    }

    if ($dryRun) {
        $report[] = "would create Roundcube user row for {$mailbox}";
        return null; // nothing to hang an identity off yet
    }

    $insert = $db->prepare(
        'INSERT INTO users (username, mail_host, created, language) VALUES (?, ?, ?, ?)'
    );
    $insert->execute([$mailbox, MAIL_HOST, gmdate('Y-m-d H:i:s'), 'en_US']);
    $report[] = "created Roundcube user row for {$mailbox}";

    return (int) $db->lastInsertId();
}

/**
 * The identity to sign.
 *
 * Only an identity whose address IS the mailbox is claimed. Someone may have
 * added a second identity for an alias they send under, and guessing that our
 * signature belongs on it would be presumptuous — so an unmatched identity is
 * left alone and a matching one is created alongside it.
 */
function findIdentity(PDO $db, int $userId, string $mailbox): ?array
{
    $find = $db->prepare(
        'SELECT identity_id, name, signature, html_signature
           FROM identities
          WHERE user_id = ? AND del = 0 AND lower(email) = lower(?)
       ORDER BY standard DESC, identity_id ASC
          LIMIT 1'
    );
    $find->execute([$userId, $mailbox]);
    $row = $find->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

$db = new PDO('sqlite:' . DB_PATH);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$report = [];
$now    = gmdate('Y-m-d H:i:s');

$db->beginTransaction();
try {
    foreach ($roster['people'] as $mailbox => $person) {
        $html   = sig_build($person, $roster['company'], $mailbox);
        $userId = findOrCreateUser($db, $mailbox, $dryRun, $report);

        if ($userId === null) {
            // --dry-run did not create the user, so there is no id to hang an
            // identity off. Report the whole chain that a real run would do.
            $report[] = "would create identity for {$mailbox} (default) + install a "
                . strlen($html) . "-byte signature";
            continue;
        }

        $identity = findIdentity($db, $userId, $mailbox);

        // ---- no identity yet: create one, signature included ----------------
        if ($identity === null) {
            // Only claim default status if there is nothing to demote.
            $others = $db->prepare('SELECT COUNT(*) FROM identities WHERE user_id = ? AND del = 0');
            $others->execute([$userId]);
            $standard = (int) $others->fetchColumn() === 0 ? 1 : 0;

            // The person's real name; the roster's identity_name covers a
            // mailbox that is not a person, so nothing sends as a bare address.
            $name = trim((string) ($person['name'] ?? ''))
                ?: trim((string) ($person['identity_name'] ?? ''));

            if ($dryRun) {
                $report[] = "would create identity for {$mailbox}"
                    . ($standard ? ' (default)' : '') . " with a " . strlen($html) . "-byte signature";
                continue;
            }

            $insert = $db->prepare(
                'INSERT INTO identities (user_id, changed, del, standard, name, organization,
                                         email, "reply-to", bcc, signature, html_signature)
                 VALUES (?, ?, 0, ?, ?, \'\', ?, \'\', \'\', ?, 1)'
            );
            $insert->execute([$userId, $now, $standard, $name, $mailbox, $html]);
            $report[] = "created identity for {$mailbox}" . ($standard ? ' (default)' : '')
                . " + installed signature (" . strlen($html) . " bytes)";
            continue;
        }

        // ---- identity exists: signature columns ONLY -------------------------
        if ($identity['signature'] === $html && (int) $identity['html_signature'] === 1) {
            $report[] = "{$mailbox}: signature already current";
        } elseif ($dryRun) {
            $was      = strlen((string) $identity['signature']);
            $report[] = $was === 0
                ? "would install a signature for {$mailbox} (" . strlen($html) . " bytes)"
                : "would replace {$mailbox}'s signature ({$was} bytes -> " . strlen($html) . ")";
        } else {
            $was    = strlen((string) $identity['signature']);
            $update = $db->prepare(
                'UPDATE identities SET signature = ?, html_signature = 1, changed = ?
                  WHERE identity_id = ?'
            );
            $update->execute([$html, $now, $identity['identity_id']]);
            $report[] = $was === 0
                ? "installed signature for {$mailbox} (" . strlen($html) . " bytes)"
                : "replaced {$mailbox}'s signature ({$was} bytes -> " . strlen($html) . ")";
        }

        // ---- opt-in, and only into a genuinely empty column -------------------
        if ($fillNames && trim((string) $identity['name']) === '') {
            $name = trim((string) ($person['name'] ?? ''))
                ?: trim((string) ($person['identity_name'] ?? ''));
            if ($name !== '') {
                if ($dryRun) {
                    $report[] = "would set {$mailbox}'s empty display name to \"{$name}\"";
                } else {
                    $setName = $db->prepare('UPDATE identities SET name = ? WHERE identity_id = ?');
                    $setName->execute([$name, $identity['identity_id']]);
                    $report[] = "set {$mailbox}'s empty display name to \"{$name}\"";
                }
            }
        }
    }

    // A dry run still runs every query so the report is real; it just never keeps
    // the result.
    if ($dryRun) {
        $db->rollBack();
    } else {
        $db->commit();
    }
} catch (Throwable $e) {
    $db->rollBack();
    fwrite(STDERR, 'signature install failed, nothing written: ' . $e->getMessage() . "\n");
    exit(1);
}

foreach ($report as $line) {
    echo "  {$line}\n";
}

$signed = $db->query(
    'SELECT COUNT(*) FROM identities WHERE del = 0 AND html_signature = 1 AND signature != \'\''
)->fetchColumn();

echo $dryRun
    ? "dry run — nothing written (" . count($roster['people']) . " mailboxes examined)\n"
    : "done — " . count($roster['people']) . " mailboxes, {$signed} identities carrying an HTML signature\n";
