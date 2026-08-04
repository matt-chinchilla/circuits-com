#!/usr/bin/env bash
#
# Install the roster's email signatures into Roundcube.
#
# Run this on the MAIL box, and again after any edit to signature-roster.php.
# It is idempotent — a signature that already matches the roster is not
# rewritten, so re-running costs nothing and changes nothing.
#
#   ./seed-signatures.sh                     install
#   ./seed-signatures.sh --dry-run           show what would change, write nothing
#   ./seed-signatures.sh --fill-blank-names  also fill EMPTY identity display
#                                            names (writes outside the signature
#                                            columns, hence opt-in — see the
#                                            header of seed-signatures.php)
#
# The work happens inside the roundcube container because that is where the
# SQLite database and a PHP with pdo_sqlite both live. Copying the scripts in
# beats piping them over stdin: `docker exec` would otherwise swallow the stdin
# of any wrapping ssh heredoc.

set -euo pipefail

CONTAINER="${ROUNDCUBE_CONTAINER:-roundcube}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DST_DIR="/tmp/circuits-signatures"

# The seeder requires the other two by path, so all three travel together and
# land in one directory.
SOURCES=(seed-signatures.php signature-template.php signature-roster.php)

for source in "${SOURCES[@]}"; do
  if [[ ! -f "${SCRIPT_DIR}/${source}" ]]; then
    echo "error: ${SCRIPT_DIR}/${source} not found" >&2
    exit 1
  fi
done

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "error: container '${CONTAINER}' is not running — start the webmail stack first" >&2
  exit 1
fi

DRY_RUN=0
for arg in "$@"; do
  [[ "${arg}" == "--dry-run" ]] && DRY_RUN=1
done

if (( DRY_RUN )); then
  echo "Dry run against ${CONTAINER} — nothing will be written..."
else
  echo "Installing signatures into ${CONTAINER}..."

  # Back the database up first. It is a single SQLite file, so a copy is a
  # complete, restorable snapshot — cheap insurance against a bad roster edit.
  # Identities and address books live in the same file, so this snapshot also
  # covers everything seed-contacts.sh wrote.
  #
  # Skipped on --dry-run: only five snapshots are kept, and spending one on a
  # run that wrote nothing could evict the snapshot taken before a run that did.
  BACKUP="/var/roundcube/db/sqlite.db.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  docker exec "${CONTAINER}" cp /var/roundcube/db/sqlite.db "${BACKUP}" </dev/null
  echo "  backup: ${BACKUP}"

  # Keep only the 5 most recent. The mail box has under a gigabyte of disk and
  # the database grows with every message, so unbounded snapshots would quietly
  # eat the room the mail server actually needs. Same window, and the same glob,
  # as seed-contacts.sh — the two scripts share one pool of snapshots.
  docker exec "${CONTAINER}" sh -c \
    'ls -1t /var/roundcube/db/sqlite.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f' </dev/null
fi

docker exec "${CONTAINER}" mkdir -p "${SEED_DST_DIR}" </dev/null
for source in "${SOURCES[@]}"; do
  docker cp "${SCRIPT_DIR}/${source}" "${CONTAINER}:${SEED_DST_DIR}/${source}"
done

docker exec "${CONTAINER}" php "${SEED_DST_DIR}/seed-signatures.php" "$@" </dev/null
docker exec "${CONTAINER}" rm -rf "${SEED_DST_DIR}" </dev/null

(( DRY_RUN )) && echo "Dry run complete." || echo "Signatures installed."
