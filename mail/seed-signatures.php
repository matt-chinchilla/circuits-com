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

/**
 * =====================================================================
 * THE LIBRARY IS READ IN PLACE, NOT SHIPPED ALONGSIDE
 *
 * This script only ever runs INSIDE the roundcube container, where the
 * signature library and the ccsignature plugin are already mounted — the very
 * files the plugin loads. So it reads them there instead of having its own
 * copies copied in beside it.
 *
 * That is the entire anti-drift argument, and it is worth being explicit about
 * because the obvious alternative looked fine. Copying the library in means the
 * box carries two of each file: the mounted one the plugin loads, and a
 * host-level one the seeder ships. Nothing keeps them equal. Let them drift and
 * the two writers of identities.signature compose a person differently and
 * overwrite each other on alternate saves — with the difference visible nowhere
 * except in sent mail. Reading the mounted copy makes them the same file by
 * construction rather than by anybody remembering to update both.
 *
 * The __DIR__ fallbacks are for a repo checkout, where nothing is mounted.
 * =====================================================================
 */

/** First readable candidate for $name, or null. */
function locateLibrary(string $name, array $dirs): ?string
{
    foreach ($dirs as $dir) {
        $path = rtrim($dir, '/') . '/' . $name;
        if (is_file($path) && is_readable($path)) {
            return $path;
        }
    }

    return null;
}

// Resolved through pluginSetting(), NOT straight from getenv(). Reading only
// the environment skipped the config layer, and lib_dir is the worst key to get
// wrong: it selects the template AND the roster AND (via the roster's own
// __DIR__) the icon list. A config override would have put the plugin on one
// library and the seeder on another — two writers with a different renderer and
// different defaults, overwriting each other on alternate saves.
//
// The value reaches this process at all because `docker exec` runs inside the
// container with the environment it was CREATED with — which is also why
// changing it in .env needs `up -d --force-recreate`, not `restart`.
$LIB_DIRS = [
    rtrim(pluginSetting('lib_dir', 'CCSIGNATURE_LIB_DIR', '/var/lib/ccsignature/lib'), '/'),
    __DIR__,
];
$SEAM_DIRS = [
    '/var/www/html/plugins/ccsignature',
    __DIR__,
    __DIR__ . '/roundcube-plugins/ccsignature',
];

$templatePath = locateLibrary('signature-template.php', $LIB_DIRS);
$rosterPath   = locateLibrary('signature-roster.php', $LIB_DIRS);
$seamPath     = locateLibrary('ccsignature_fields.php', $SEAM_DIRS);

foreach ([
    'signature-template.php'  => [$templatePath, $LIB_DIRS],
    'signature-roster.php'    => [$rosterPath, $LIB_DIRS],
    'ccsignature_fields.php'  => [$seamPath, $SEAM_DIRS],
] as $name => [$found, $dirs]) {
    if ($found === null) {
        fwrite(STDERR, "{$name} not found; nothing written.\n");
        fwrite(STDERR, '  looked in: ' . implode(', ', $dirs) . "\n");
        exit(1);
    }
}

require_once $templatePath;
require_once $seamPath;

// SAY WHICH FILES THESE ACTUALLY WERE, every run.
//
// A box can end up carrying two copies of the roster — the mounted one and a
// root-level leftover from an older copy-everything deploy — and only the
// mounted one is read. Someone correcting a phone number in the wrong copy
// otherwise gets "signature already current", which is not an error, produces
// no diff, and gives them nothing to grep for. Three lines of provenance turn
// that into something visible the first time anyone looks.
echo "  template: {$templatePath}\n";
echo "  roster:   {$rosterPath}\n";
echo "  seam:     {$seamPath}\n";

// --check stops here: resolution succeeded, nothing else was touched.
//
// It exists so seed-signatures.sh can prove the library is mounted BEFORE it
// takes its database snapshot. The snapshots rotate five deep, so a run that
// was always going to fail would otherwise evict the snapshot taken before a
// run that actually wrote something.
//
// Read straight from $argv because the option parser below has not run yet, and
// deliberately so: this check must happen before anything, including argument
// validation, or it is not a preflight.
if (in_array('--check', $argv, true)) {
    echo "  library resolved; nothing written\n";
    exit(0);
}

/**
 * One value out of Roundcube's config, without importing Roundcube.
 *
 * BOTH FILES, PLUGIN FIRST. rcube_plugin::load_config() merges
 * plugins/ccsignature/config.inc.php into the global config, so
 * $rc->config->get() sees it and it OVERRIDES the main file. Reading only the
 * main file left the drift this function exists to close still open, and open
 * along the exact path config.inc.php.dist tells an operator to take: set
 * ccsignature_avatar_base there and the plugin would honour it while the seeder
 * did not, so the two writers emit different <img src> for the same person and
 * overwrite each other on alternate saves.
 *
 * `include` inside a function body so the `$config` those files build is scoped
 * to this call and cannot collide with anything in the seeder. Output is
 * buffered and warnings silenced because roundcube-config.inc.php includes
 * config.docker.inc.php in turn — a missing one would otherwise print a PHP
 * warning into the middle of this script's report.
 *
 * Absent or unreadable is not an error; it just means there is no override.
 * A file with a PARSE error is fatal and uncatchable, which is tolerable here
 * only because it happens before the first write — and because Roundcube itself
 * would already be down.
 */
function roundcubeConfigValue(string $key)
{
    $files = [
        '/var/www/html/plugins/ccsignature/config.inc.php',
        '/var/www/html/config/config.inc.php',
    ];

    foreach ($files as $file) {
        if (!is_file($file) || !is_readable($file)) {
            continue;
        }

        $config = [];

        ob_start();
        $previous = error_reporting(0);
        include $file;
        error_reporting($previous);
        ob_end_clean();

        if (isset($config[$key])) {
            return $config[$key];
        }
    }

    return null;
}

/**
 * One ccsignature setting, resolved EXACTLY as the plugin resolves it.
 *
 * A deliberate line-by-line mirror of ccsignature::setting(), including the two
 * places it would be tempting to write more idiomatic PHP:
 *
 *   - the emptiness tests are `=== ''`, not `?:`, so a value of '0' survives
 *     here as it does there;
 *   - nothing is trimmed, so a whitespace-only value degrades on both sides
 *     rather than falling through on one.
 *
 * Neither value is plausible in practice. Mirroring anyway is the cheaper habit:
 * the whole reason this script and the plugin share a seam is that two writers
 * of the same column must not disagree, and "they agree for every input anyone
 * would actually type" is a weaker property than "they agree".
 *
 * Config beats environment beats default, and roundcubeConfigValue() reads the
 * plugin's own config.inc.php before Roundcube's main one — the order
 * rcube_plugin::load_config() merges them in.
 */
function pluginSetting(string $key, string $env, string $default): string
{
    $value = roundcubeConfigValue('ccsignature_' . $key);

    if ($value === null || $value === '') {
        $fromEnv = getenv($env);
        if ($fromEnv !== false && $fromEnv !== '') {
            $value = $fromEnv;
        }
    }

    return $value === null || $value === '' ? $default : (string) $value;
}

/**
 * Where headshots are published from. Only ever read, never written here — a
 * person's uploaded photo already lives in the volume by the time this runs.
 */
$avatarBase = rtrim(
    pluginSetting('avatar_base', 'CCSIGNATURE_AVATAR_BASE', 'https://mail.circuitcenter.ai/avatars'),
    '/'
);

$options   = array_slice($argv, 1);
$dryRun    = in_array('--dry-run', $options, true);
$fillNames = in_array('--fill-blank-names', $options, true);

foreach ($options as $option) {
    // --check is listed even though the gate above exits before this line can
    // run, so today it changes nothing either way. It stays because the only
    // thing making it unreachable is where that gate sits, and a gate that
    // moves would otherwise turn this into "unknown option: --check".
    if (!in_array($option, ['--dry-run', '--fill-blank-names', '--check'], true)) {
        fwrite(STDERR, "unknown option: {$option}\n");
        exit(2);
    }
}

// The mounted roster, resolved above — the same file the plugin reads, which is
// what keeps the two writers agreeing on the defaults. It pulls in
// signature-icon-slugs.php itself, by __DIR__, so that comes from beside it.
$roster = require $rosterPath;

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
/**
 * Compose and render one signature.
 *
 * Deliberately the ONLY sig_build() call in this file, and it goes through
 * ccsig_person() exactly as the plugin does. Two writers of identities.signature
 * that composed a person even slightly differently would fight — each
 * overwriting the other on alternate saves — and the difference would surface in
 * sent mail rather than anywhere either author was looking.
 */
function renderSignature(
    array $fields, array $person, array $roster, string $mailbox, string $avatarBase
): string {
    return sig_build(ccsig_person($fields, $person, $avatarBase), $roster['company'], $mailbox);
}

/**
 * One user's stored ccsignature fields, keyed by identity id.
 *
 * Roundcube keeps preferences as a plain serialize() blob in users.preferences.
 * Anything unreadable is treated as "none", never as an error: this script's job
 * is to install signatures, and a corrupt preference blob is a reason to fall
 * back to the roster rather than a reason to refuse to run.
 */
function readSignaturePrefs(PDO $db, int $userId): array
{
    $find = $db->prepare('SELECT preferences FROM users WHERE user_id = ?');
    $find->execute([$userId]);
    $blob = $find->fetchColumn();

    if (!is_string($blob) || $blob === '') {
        return [];
    }

    $all = @unserialize($blob, ['allowed_classes' => false]);

    return is_array($all) ? ccsig_prefs_read($all['ccsignature'] ?? null) : [];
}

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
        $userId = findOrCreateUser($db, $mailbox, $dryRun, $report);

        if ($userId === null) {
            // --dry-run did not create the user, so there is no id to hang an
            // identity off, and no preferences to read either. Report the whole
            // chain that a real run would do, from the roster alone.
            $html = renderSignature(
                ccsig_fields_for('', [], $mailbox, $roster), $person, $roster, $mailbox, $avatarBase
            );
            $report[] = "would create identity for {$mailbox} (default) + install a "
                . strlen($html) . "-byte signature";
            continue;
        }

        $identity = findIdentity($db, $userId, $mailbox);

        // WHAT THE PERSON SET IN WEBMAIL WINS. Before the ccsignature plugin
        // existed this script rendered the roster unconditionally, so running it
        // after somebody had corrected their own phone number would silently put
        // the old one back — and the only place that shows is outgoing mail.
        // Their stored fields are read here and the roster is now the DEFAULT
        // rather than the source.
        $fields = ccsig_fields_for(
            $identity['identity_id'] ?? '', readSignaturePrefs($db, $userId), $mailbox, $roster
        );

        if (($fields['enabled'] ?? '1') === '0') {
            $report[] = "{$mailbox}: opted out in webmail, signature left untouched";
            continue;
        }

        $html = renderSignature($fields, $person, $roster, $mailbox, $avatarBase);

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
