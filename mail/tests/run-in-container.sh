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
for f in signature-template.php signature-roster.php signature-icon-slugs.php signature-brand-icons.json; do
  docker cp "${MAIL_DIR}/${f}" "${CONTAINER}:${DST}/${f}"
done
for f in ccsignature_fields.php ccsignature_image.php; do
  docker cp "${MAIL_DIR}/roundcube-plugins/ccsignature/${f}" \
            "${CONTAINER}:${DST}/roundcube-plugins/ccsignature/${f}"
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
