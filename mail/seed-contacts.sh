#!/usr/bin/env bash
#
# Seed the company roster into every mailbox's Roundcube address book.
#
# Run this on the MAIL box after setup-mailboxes.sh, and again whenever the
# roster in seed-contacts.php changes. It is idempotent — re-running updates
# names in place instead of duplicating contacts.
#
#   ./seed-contacts.sh
#
# The work happens inside the roundcube container because that is where the
# SQLite address book and a PHP with pdo_sqlite both live. Copying the script
# in beats piping it over stdin: `docker exec` would otherwise swallow the
# stdin of any wrapping ssh heredoc.

set -euo pipefail

CONTAINER="${ROUNDCUBE_CONTAINER:-roundcube}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_SRC="${SCRIPT_DIR}/seed-contacts.php"
SEED_DST="/tmp/seed-contacts.php"

if [[ ! -f "${SEED_SRC}" ]]; then
  echo "error: ${SEED_SRC} not found" >&2
  exit 1
fi

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "error: container '${CONTAINER}' is not running — start the webmail stack first" >&2
  exit 1
fi

echo "Seeding contacts into ${CONTAINER}..."

# Back the address book up first. It is a single SQLite file, so a copy is a
# complete, restorable snapshot — cheap insurance against a bad roster edit.
BACKUP="/var/roundcube/db/sqlite.db.bak-$(date -u +%Y%m%dT%H%M%SZ)"
docker exec "${CONTAINER}" cp /var/roundcube/db/sqlite.db "${BACKUP}" </dev/null
echo "  backup: ${BACKUP}"

# Keep only the 5 most recent. The mail box has under a gigabyte of disk and
# the database grows with every message, so unbounded snapshots would quietly
# eat the room the mail server actually needs.
docker exec "${CONTAINER}" sh -c \
  'ls -1t /var/roundcube/db/sqlite.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f' </dev/null

docker cp "${SEED_SRC}" "${CONTAINER}:${SEED_DST}"
docker exec "${CONTAINER}" php "${SEED_DST}" </dev/null
docker exec "${CONTAINER}" rm -f "${SEED_DST}" </dev/null

echo "Contacts seeded."
