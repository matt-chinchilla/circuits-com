#!/usr/bin/env bash
#
# Run the PHP tests INSIDE the roundcube container.
#
# Needed because the machine this repo is edited from has no imagick, no gd and
# no pdo_sqlite, while the container has all three — so test_image.php skips
# locally and only actually runs here. More to the point, every memory claim in
# ccsignature_image.php is a claim about THAT container's 192MB cgroup, and a
# claim about a cgroup can only be tested inside it.
#
#   ./run-in-container.sh                 everything
#   ./run-in-container.sh image           one file
#   CONTAINER=roundcube ./run-in-container.sh
#
# Read-only with respect to the deployment: the sources are copied to /tmp in
# the container, run, and removed. Nothing bind-mounted is touched, and no
# Roundcube state is read or written.

set -euo pipefail

CONTAINER="${CONTAINER:-roundcube}"
FILTER="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIL_DIR="$(cd "${HERE}/.." && pwd)"
DST="/tmp/ccsig-tests"

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "error: container '${CONTAINER}' is not running." >&2
  echo "  On the mail box this needs sudo; from a workstation, run it over ssh." >&2
  exit 1
fi

docker exec "${CONTAINER}" rm -rf "${DST}" < /dev/null
docker exec "${CONTAINER}" mkdir -p "${DST}/tests" "${DST}/roundcube-plugins/ccsignature" < /dev/null

# Only what the tests require. signature-roster.php and signature-template.php
# come too, because test_fields.php asserts byte-identity against the real
# roster rather than a fixture of it.
#
# SOURCED FROM INSIDE THE CONTAINER WHEN THEY ARE MOUNTED THERE, and from the
# host only as a fallback. On the mail box the library lives in signature/ and
# the plugin in plugins/ — not beside this script, as it is in a checkout — so
# copying blindly from ${MAIL_DIR} aborted with "no such file or directory" the
# first time this ran on the box. Preferring the mounted copy also means the
# tests exercise the exact files the running plugin loads, which is the whole
# reason for running them here rather than on a workstation.
copy_in() {
  local name="$1" dest="$2" src
  for src in "$3" "$4"; do
    if docker exec "${CONTAINER}" test -r "${src}" < /dev/null 2>/dev/null; then
      docker exec "${CONTAINER}" cp "${src}" "${dest}" < /dev/null
      return 0
    fi
  done
  for src in "$5" "$6"; do
    if [[ -n "${src}" && -f "${src}" ]]; then
      docker cp "${src}" "${CONTAINER}:${dest}"
      return 0
    fi
  done
  echo "error: ${name} not found in the container or under ${MAIL_DIR}" >&2
  exit 1
}

LIB=/var/lib/ccsignature/lib
PLG=/var/www/html/plugins/ccsignature

for f in signature-template.php signature-roster.php signature-icon-slugs.php signature-brand-icons.json; do
  copy_in "${f}" "${DST}/${f}" "${LIB}/${f}" "" "${MAIL_DIR}/${f}" "${MAIL_DIR}/signature/${f}"
done
for f in ccsignature_fields.php ccsignature_image.php; do
  copy_in "${f}" "${DST}/roundcube-plugins/ccsignature/${f}" "${PLG}/${f}" "" \
          "${MAIL_DIR}/roundcube-plugins/ccsignature/${f}" "${MAIL_DIR}/plugins/ccsignature/${f}"
done
for f in run.php test_template.php test_fields.php test_image.php; do
  docker cp "${MAIL_DIR}/tests/${f}" "${CONTAINER}:${DST}/tests/${f}"
done

# test_template.php's two on-disk icon checks read frontend/public/images/sig,
# which belongs to the WEB repo and is not on this box. They detect that
# themselves and skip with a printed reason — deliberately not faked with an
# empty directory here, which would have made them fail instead.

set +e
docker exec "${CONTAINER}" php "${DST}/tests/run.php" ${FILTER} < /dev/null
STATUS=$?
set -e

docker exec "${CONTAINER}" rm -rf "${DST}" < /dev/null
exit "${STATUS}"
