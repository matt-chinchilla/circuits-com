#!/usr/bin/env bash
#
# Install the roster's email signatures into Roundcube.
#
# Run this on the MAIL box, and again after any edit to signature-roster.php.
# It is idempotent — a signature that already matches is not rewritten, so
# re-running costs nothing and changes nothing.
#
# EDIT THE MOUNTED COPY: /opt/circuits-mail/signature/signature-roster.php.
# That is the one both this script and the running plugin read. If an older
# deploy left a copy at /opt/circuits-mail/signature-roster.php it is now inert,
# and editing it produces "signature already current" rather than an error —
# delete it. Every run prints the three paths it actually resolved, so a stale
# twin shows itself the first time anyone looks.
#
#   ./seed-signatures.sh                     install
#   ./seed-signatures.sh --dry-run           show what would change, write nothing
#   ./seed-signatures.sh --fill-blank-names  also fill EMPTY identity display
#                                            names (writes outside the signature
#                                            columns, hence opt-in — see the
#                                            header of seed-signatures.php)
#
# The work happens inside the roundcube container because that is where the
# SQLite database and a PHP with pdo_sqlite both live. Copying the script in
# beats piping it over stdin: `docker exec` would otherwise swallow the stdin of
# any wrapping ssh heredoc.

set -euo pipefail

CONTAINER="${ROUNDCUBE_CONTAINER:-roundcube}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DST_DIR="/tmp/circuits-signatures"

# ONE file travels. That is the point, not an economy.
#
# The signature library and the ccsignature plugin are already inside the
# container — docker-compose.webmail.yml mounts them, and the plugin loads them
# from there. seed-signatures.php reads those same mounted files rather than
# carrying its own copies, so the seeder and the plugin are provably running the
# same code instead of two copies somebody has to remember to update together.
#
# It also sidesteps the fact that the box is NOT a mirror of this directory: it
# renames roundcube-skin/ to skin/ and roundcube-plugins/ to plugins/ by hand.
# Shipping the library from the host meant guessing that layout, and guessing it
# wrong aborted the whole run — including the backup — before anything happened.
#
# seed-signatures.php is the one file with no copy in the container, because
# nothing mounts it there.
SEED_SCRIPT="seed-signatures.php"

if [[ ! -f "${SCRIPT_DIR}/${SEED_SCRIPT}" ]]; then
  echo "error: ${SCRIPT_DIR}/${SEED_SCRIPT} not found" >&2
  exit 1
fi

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "error: container '${CONTAINER}' is not running — start the webmail stack first" >&2
  exit 1
fi

DRY_RUN=0
for arg in "$@"; do
  [[ "${arg}" == "--dry-run" ]] && DRY_RUN=1

  # --check is this script's OWN preflight, not an option to pass it. Handed
  # through to the real run it would take the backup, consume a rotation slot,
  # exit at the seeder's gate having written nothing — and then print
  # "Signatures installed." A wrapper that reports success for a run that did
  # nothing is the failure this whole script is careful about.
  if [[ "${arg}" == "--check" ]]; then
    echo "error: --check is internal — it resolves the library and writes nothing." >&2
    echo "  You almost certainly want --dry-run." >&2
    exit 2
  fi
done

# Copy the script in, then PREFLIGHT before touching anything.
#
# --check resolves the library and exits without opening the database. It runs
# ahead of the backup on purpose: the snapshots rotate five deep, so a run that
# was never going to work — the container recreated without the ccsignature
# mounts, say — would otherwise evict the snapshot taken before a run that
# actually wrote something. The check reuses the seeder's own resolution rather
# than re-testing a hard-coded path here, so the two cannot disagree about where
# the library is.
docker exec "${CONTAINER}" mkdir -p "${SEED_DST_DIR}" </dev/null
docker cp "${SCRIPT_DIR}/${SEED_SCRIPT}" "${CONTAINER}:${SEED_DST_DIR}/${SEED_SCRIPT}"

# stdout only: the check echoes the same three resolved paths the real run does,
# and printing them twice reads as a stutter. Its failure output is on stderr and
# still reaches the operator.
if ! docker exec "${CONTAINER}" php "${SEED_DST_DIR}/${SEED_SCRIPT}" --check </dev/null >/dev/null; then
  # `|| true` because a wedged container is often WHY the check failed, and
  # under `set -e` a failing cleanup would exit here and swallow the three lines
  # that tell the operator what to do about it. The exit stays non-zero either
  # way; only the guidance would have been lost.
  docker exec "${CONTAINER}" rm -rf "${SEED_DST_DIR}" </dev/null || true
  echo "error: the signature library is not reachable inside ${CONTAINER}" >&2
  echo "  recreate the container so the ccsignature mounts exist:" >&2
  echo "  docker compose -f docker-compose.webmail.yml up -d --force-recreate roundcube" >&2
  exit 1
fi

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

docker exec "${CONTAINER}" php "${SEED_DST_DIR}/${SEED_SCRIPT}" "$@" </dev/null
docker exec "${CONTAINER}" rm -rf "${SEED_DST_DIR}" </dev/null

(( DRY_RUN )) && echo "Dry run complete." || echo "Signatures installed."
