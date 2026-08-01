<?php
/**
 * Seed the company roster into every mailbox's Roundcube address book, so
 * anyone opening webmail already has their colleagues on autocomplete instead
 * of typing addresses from memory.
 *
 * Run it through seed-contacts.sh, which copies this into the container.
 *
 * WHY THIS PRE-CREATES USER ROWS
 * Roundcube keys address books on users.user_id and creates that row on FIRST
 * LOGIN. Seeding only the rows that already exist would mean nobody sees a
 * contact until after they have logged in once — precisely the moment the
 * roster is most useful — so this creates the row up front.
 *
 * That makes the (username, mail_host) pair load-bearing: it must equal what
 * Roundcube itself would write, or login creates a SECOND row and these
 * contacts silently vanish. Both values are taken from the live install, not
 * guessed — mail_host is ROUNDCUBEMAIL_DEFAULT_HOST from the compose file,
 * and login_lc=2 (Roundcube's default) lower-cases the entire username, which
 * every address here already is.
 *
 * Idempotent: re-run it after hiring someone. Existing contacts are updated in
 * place rather than duplicated, and a contact someone deliberately deleted is
 * left deleted — the roster seeds an address book, it does not police it.
 */

const DB_PATH   = '/var/roundcube/db/sqlite.db';
const MAIL_HOST = 'mailserver'; // must match ROUNDCUBEMAIL_DEFAULT_HOST

/** The roster. Each person becomes a contact in everyone else's address book. */
$people = [
    'matthew@circuitcenter.ai' => ['Matthew', 'Chirichella'],
    'daniel@circuitcenter.ai'  => ['Daniel',  'Turano'],
    'anthony@circuitcenter.ai' => ['Anthony', 'Martinez'],
    'ronald@circuitcenter.ai'  => ['Ronald',  'Hausske'],
];

/**
 * Mailboxes that RECEIVE the roster but are not people. Whoever works the
 * shared inbox gets the same autocomplete, and nobody ends up with a
 * "no-reply" entry sitting in their contact list.
 */
$sharedMailboxes = ['no-reply@circuitcenter.ai'];

/** Roundcube stores contact detail as a vCard; the columns drive list + search. */
function buildVcard(string $first, string $last, string $email): string
{
    $lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        "N:{$last};{$first};;;",
        "FN:{$first} {$last}",
        "EMAIL;TYPE=INTERNET;TYPE=WORK:{$email}",
        'END:VCARD',
    ];

    return implode("\r\n", $lines) . "\r\n";
}

function findOrCreateUser(PDO $db, string $email, array &$report): int
{
    $find = $db->prepare('SELECT user_id FROM users WHERE username = ? AND mail_host = ?');
    $find->execute([$email, MAIL_HOST]);
    $existing = $find->fetchColumn();

    if ($existing !== false) {
        return (int) $existing;
    }

    $insert = $db->prepare(
        'INSERT INTO users (username, mail_host, created, language) VALUES (?, ?, ?, ?)'
    );
    $insert->execute([$email, MAIL_HOST, gmdate('Y-m-d H:i:s'), 'en_US']);
    $report[] = "created Roundcube user row for {$email}";

    return (int) $db->lastInsertId();
}

function upsertContact(
    PDO $db,
    int $ownerId,
    string $ownerEmail,
    string $first,
    string $last,
    string $email,
    array &$report
): void {
    $name  = "{$first} {$last}";
    $words = strtolower("{$first} {$last} {$email}");
    $vcard = buildVcard($first, $last, $email);
    $now   = gmdate('Y-m-d H:i:s');

    // Match regardless of `del` so a re-run cannot resurrect a contact the
    // mailbox owner removed on purpose.
    $find = $db->prepare('SELECT contact_id, del FROM contacts WHERE user_id = ? AND email = ?');
    $find->execute([$ownerId, $email]);
    $row = $find->fetch(PDO::FETCH_ASSOC);

    if ($row && (int) $row['del'] === 1) {
        $report[] = "skipped {$email} for {$ownerEmail} (deleted by the owner)";
        return;
    }

    if ($row) {
        $update = $db->prepare(
            'UPDATE contacts SET name = ?, firstname = ?, surname = ?, vcard = ?, words = ?, changed = ?
             WHERE contact_id = ?'
        );
        $update->execute([$name, $first, $last, $vcard, $words, $now, $row['contact_id']]);
        return;
    }

    $insert = $db->prepare(
        'INSERT INTO contacts (user_id, changed, del, name, email, firstname, surname, vcard, words)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)'
    );
    $insert->execute([$ownerId, $now, $name, $email, $first, $last, $vcard, $words]);
    $report[] = "added {$name} <{$email}> to {$ownerEmail}";
}

$db = new PDO('sqlite:' . DB_PATH);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$report   = [];
$mailboxes = array_merge(array_keys($people), $sharedMailboxes);

$db->beginTransaction();
try {
    foreach ($mailboxes as $mailbox) {
        $ownerId = findOrCreateUser($db, $mailbox, $report);

        foreach ($people as $email => [$first, $last]) {
            if ($email === $mailbox) {
                continue; // nobody needs themselves in their own address book
            }
            upsertContact($db, $ownerId, $mailbox, $first, $last, $email, $report);
        }
    }
    $db->commit();
} catch (Throwable $e) {
    $db->rollBack();
    fwrite(STDERR, 'seed failed, nothing written: ' . $e->getMessage() . "\n");
    exit(1);
}

foreach ($report as $line) {
    echo "  {$line}\n";
}
echo $report ? '' : "  everything already in place\n";

$total = $db->query('SELECT COUNT(*) FROM contacts WHERE del = 0')->fetchColumn();
echo "done — " . count($mailboxes) . " mailboxes, {$total} contacts total\n";
