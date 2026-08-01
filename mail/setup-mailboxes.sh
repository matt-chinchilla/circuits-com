#!/usr/bin/env bash
#
# circuitcenter.ai — provision the five mailboxes on the mail box (P2).
#
# Creates any missing mailbox with a strong random password generated HERE, on
# the box, from openssl's CSPRNG. Passwords are written to a 0600 file and are
# never printed, logged, passed as a command-line argument, or sent anywhere.
#
# IDEMPOTENT. Re-running is safe and is the intended way to apply an alias
# change or repair a quota:
#   - an existing mailbox is left completely alone (its password is NOT rotated
#     and its credential line is NOT rewritten)
#   - quotas are only written when they differ
#   - the alias file is only copied in when its content differs
#
# Usage (on the mail box, as root):
#   cd /opt/circuits-com/mail && ./setup-mailboxes.sh
#
# Overridable by environment: COMPOSE_FILE ENV_FILE SERVICE CRED_FILE
#                             MAIL_DOMAIN QUOTA ALIAS_FILE
#
set -Eeuo pipefail
umask 077

# Refuse to run under `bash -x`: xtrace would print every generated password to
# stderr, which is exactly what this script exists to prevent.
case ${-} in
  *x*) printf 'refusing to run under xtrace (passwords would be printed)\n' >&2; exit 2 ;;
esac

# Split across two statements on purpose: `readonly X="$(...)"` returns the exit
# status of `readonly`, not of the substitution, so `set -e` would not catch a
# failing `cd`.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

COMPOSE_FILE="${COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.mail.yml}"
ALIAS_FILE="${ALIAS_FILE:-${SCRIPT_DIR}/postfix-virtual.cf}"
# Compose needs this for the ${SES_SMTP_*:?} interpolation in the compose file.
# Without it every `docker compose exec` below aborts before it reaches the
# container.
ENV_FILE="${ENV_FILE:-/opt/circuits-com/.env}"
SERVICE="${SERVICE:-mailserver}"
CRED_FILE="${CRED_FILE:-/opt/circuits-com/mail-credentials.txt}"
MAIL_DOMAIN="${MAIL_DOMAIN:-circuitcenter.ai}"
QUOTA="${QUOTA:-1G}"

# The five mailboxes. `demo` is deliberately absent: it is a site login
# identity only and has no mailbox (see the P2 design doc).
readonly MAILBOX_USERS=(anthony daniel matthew ronald no-reply)

# 20 chars from a 76-character set is ~125 bits of entropy, and stays inside
# the site's 8-24 character password policy so these can be reused verbatim
# once P3 unifies the two credentials. The set excludes quotes, backslash,
# backtick, $, and shell/URL metacharacters that make copy-paste into a mail
# client or an .env file go wrong.
readonly PASSWORD_LENGTH=20
readonly PASSWORD_CHARSET='A-Za-z0-9!#%*+,.:=?@^_~-'

readonly CONTAINER_CONFIG_DIR='/tmp/docker-mailserver'
readonly ACCOUNTS_DB="${CONTAINER_CONFIG_DIR}/postfix-accounts.cf"
readonly QUOTAS_DB="${CONTAINER_CONFIG_DIR}/dovecot-quotas.cf"
readonly VIRTUAL_DB="${CONTAINER_CONFIG_DIR}/postfix-virtual.cf"

created_count=0
skipped_count=0

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# `exec -T` is required (no TTY) and it CONSUMES the caller's stdin, so every
# call site that does not deliberately feed it something redirects </dev/null.
dms() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
    exec -T "${SERVICE}" "$@"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
  (( $# == 0 )) || die "takes no arguments (configure via environment: COMPOSE_FILE ENV_FILE SERVICE CRED_FILE MAIL_DOMAIN QUOTA ALIAS_FILE)"

  command -v docker  >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  command -v openssl >/dev/null 2>&1 || die "openssl is not installed; it is the entropy source for passwords"

  [[ -r ${COMPOSE_FILE} ]] || die "compose file not found or unreadable: ${COMPOSE_FILE}"
  [[ -r ${ALIAS_FILE}   ]] || die "alias file not found or unreadable: ${ALIAS_FILE}"
  [[ -r ${ENV_FILE}     ]] || die "env file not found or unreadable: ${ENV_FILE} (it holds SES_SMTP_USERNAME/SES_SMTP_PASSWORD)"

  # Not fatal — mailbox provisioning works fine without it — but a missing
  # certificate means DMS started with TLS disabled, which is silent and is the
  # most common consequence of running these steps out of order.
  if [[ ! -e /etc/letsencrypt/live/mail.${MAIL_DOMAIN}/fullchain.pem ]]; then
    warn "no certificate at /etc/letsencrypt/live/mail.${MAIL_DOMAIN}/fullchain.pem —
         SSL_TYPE=letsencrypt has nothing to load and the server is running
         WITHOUT TLS. See step 4 in README.md, then restart the stack."
  fi

  local cred_dir
  cred_dir="$(dirname -- "${CRED_FILE}")"
  [[ -d ${cred_dir} ]] || die "credentials directory does not exist: ${cred_dir}"

  # Prove the credentials file is writable BEFORE creating any account. If this
  # failed later, a mailbox would exist whose password nobody has recorded.
  if [[ -e ${CRED_FILE} ]]; then
    [[ -w ${CRED_FILE} ]] || die "cannot write ${CRED_FILE} (run as root)"
  else
    install -m 600 /dev/null "${CRED_FILE}" \
      || die "cannot create ${CRED_FILE} (run as root)"
    {
      printf '# circuitcenter.ai mailbox credentials\n'
      printf '# Generated by mail/setup-mailboxes.sh. Mode 0600, root only.\n'
      printf '# NEVER commit this file, paste it into a ticket, or email it.\n'
      printf '#\n'
      printf '# These are bootstrap passwords. Once P3 credential push-sync is live,\n'
      printf '# changing a site password rewrites the mailbox hash and the value below\n'
      printf '# goes stale — it is not rewritten here.\n'
      printf '#\n'
      printf '# Append-only. If an address appears more than once, the mailbox was\n'
      printf '# deleted and re-created; the line with the LATEST timestamp is the\n'
      printf '# current password and the earlier ones are dead history.\n'
      printf '#\n'
      printf '# To rotate one by hand:\n'
      printf '#   docker compose -f docker-compose.mail.yml exec mailserver \\\n'
      printf '#     setup email update <address>\n'
      printf '#\n'
      printf '# address                      password              created\n'
    } >>"${CRED_FILE}"
  fi
  # Self-heal the mode in case someone widened it.
  chmod 600 "${CRED_FILE}"
}

# DMS's first boot generates state and can take minutes on a t4g.micro.
# `doveadm pw` is the specific dependency `setup email add` has, so probe that
# rather than something merely correlated with readiness.
wait_for_container() {
  local waited=0 limit=300
  log "==> Waiting for ${SERVICE} to be ready (up to ${limit}s)..."
  while ! dms doveadm pw -s SHA512-CRYPT -p readiness-probe >/dev/null 2>&1 </dev/null; do
    (( waited += 5 ))
    if (( waited >= limit )); then
      die "${SERVICE} did not become ready within ${limit}s.
     Check:  docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} logs --tail 100 ${SERVICE}"
    fi
    sleep 5
  done
  log "    ready."
}

# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

# One address per line, from the DMS account database inside the container.
# Reading the database directly (rather than parsing `setup email list`) keeps
# this independent of that command's human-facing output format, and it does
# not fail when no accounts exist yet.
existing_accounts() {
  dms bash -c "
    if [ -f '${ACCOUNTS_DB}' ]; then
      grep -v '^[[:space:]]*#' '${ACCOUNTS_DB}' | grep '|' | cut -d'|' -f1
    fi
  " </dev/null
}

account_exists() {
  local address="${1}" existing="${2}"
  grep -qxF -- "${address}" <<<"${existing}"
}

# Writes a password to stdout. Never call this anywhere the value could be
# logged. Retries until the value satisfies the site's password policy
# (upper + lower + digit + symbol) so it stays interchangeable with a site
# password under P3.
generate_password() {
  local candidate attempt
  for (( attempt = 0; attempt < 100; attempt++ )); do
    # `cut` rather than `head -c`: head closes the pipe early, which under
    # `pipefail` turns openssl's SIGPIPE into a script-killing non-zero exit.
    candidate="$(openssl rand 512 | LC_ALL=C tr -dc "${PASSWORD_CHARSET}" | cut -c1-"${PASSWORD_LENGTH}")"

    [[ ${#candidate} -eq ${PASSWORD_LENGTH} ]] || continue
    [[ ${candidate} == *[[:upper:]]* ]]        || continue
    [[ ${candidate} == *[[:lower:]]* ]]        || continue
    [[ ${candidate} == *[[:digit:]]* ]]        || continue
    # At least one non-alphanumeric character.
    [[ -n "$(printf '%s' "${candidate}" | LC_ALL=C tr -d 'A-Za-z0-9')" ]] || continue

    printf '%s' "${candidate}"
    return 0
  done
  die "could not generate a policy-compliant password after 100 attempts"
}

create_account() {
  local address="${1}" password="${2}"

  # The password goes in on STDIN, never as an argv element: an argument would
  # be visible in `ps` on the box and in the shell history of whoever runs
  # this. `setup email add` prompts twice when no password argument is given,
  # and bash's `read -p` suppresses the prompt text when stdin is not a TTY, so
  # nothing is echoed either.
  printf '%s\n%s\n' "${password}" "${password}" \
    | dms setup email add "${address}" >/dev/null
}

provision_accounts() {
  local existing address password user

  log "==> Provisioning mailboxes for @${MAIL_DOMAIN}"
  existing="$(existing_accounts)"

  for user in "${MAILBOX_USERS[@]}"; do
    address="${user}@${MAIL_DOMAIN}"

    if account_exists "${address}" "${existing}"; then
      log "    ${address}: exists, leaving untouched"
      (( ++skipped_count ))
      continue
    fi

    password="$(generate_password)"
    create_account "${address}" "${password}"

    # Post-condition. If the stdin hand-off ever stops working (a future DMS
    # release changing the prompt, say) this catches it here instead of at the
    # first failed login, and before a password is recorded that does not work.
    existing="$(existing_accounts)"
    if ! account_exists "${address}" "${existing}"; then
      password=''
      die "created ${address} but it is absent from ${ACCOUNTS_DB}.
     The password was NOT recorded. Create it interactively instead:
       docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} exec ${SERVICE} setup email add ${address}"
    fi

    printf '%-28s %-21s %s\n' \
      "${address}" "${password}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${CRED_FILE}"
    password=''

    log "    ${address}: created, password written to ${CRED_FILE}"
    (( ++created_count ))
  done
}

# ---------------------------------------------------------------------------
# Quotas
# ---------------------------------------------------------------------------

apply_quotas() {
  local address current user

  log "==> Applying ${QUOTA} per-mailbox quota"
  current="$(dms bash -c "[ -f '${QUOTAS_DB}' ] && cat '${QUOTAS_DB}' || true" </dev/null)"

  for user in "${MAILBOX_USERS[@]}"; do
    address="${user}@${MAIL_DOMAIN}"
    if grep -qxF -- "${address}:${QUOTA}" <<<"${current}"; then
      log "    ${address}: already ${QUOTA}"
      continue
    fi
    dms setup quota set "${address}" "${QUOTA}" >/dev/null </dev/null
    log "    ${address}: set to ${QUOTA}"
  done
}

# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------

# A bare `@domain` catch-all out-ranks a real mailbox in Postfix's virtual
# alias lookup, so every managed address needs a self-alias to survive. This is
# a HARD check: installing the catch-all without them would silently divert a
# person's mail to the shared inbox with no error anywhere. See aliases.md.
verify_alias_file() {
  local address missing=() last_line user

  for user in "${MAILBOX_USERS[@]}"; do
    address="${user}@${MAIL_DOMAIN}"
    if ! grep -qE "^[[:space:]]*${address//./\\.}[[:space:]]+${address//./\\.}[[:space:]]*$" "${ALIAS_FILE}"; then
      missing+=("${address}")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    die "${ALIAS_FILE} is missing a self-alias for: ${missing[*]}
     Without '<address>  <address>' the catch-all silently swallows that
     mailbox's mail. Add the line(s) above the '@${MAIL_DOMAIN}' entry and
     re-run. Nothing was changed on the container. See aliases.md."
  fi

  # Postfix's texthash map keys on the address, so file order does not change
  # today's behaviour — but it does for a regexp map, and upstream documents
  # the specific-above-wildcard convention. Warn, do not block.
  last_line="$(grep -vE '^[[:space:]]*(#|$)' "${ALIAS_FILE}" | tail -n 1)"
  if [[ ${last_line} != "@${MAIL_DOMAIN}"[[:space:]]* ]]; then
    warn "the '@${MAIL_DOMAIN}' catch-all is not the last entry in ${ALIAS_FILE}"
  fi
}

install_aliases() {
  log "==> Installing alias map"
  verify_alias_file

  local in_container
  in_container="$(dms bash -c "[ -f '${VIRTUAL_DB}' ] && cat '${VIRTUAL_DB}' || true" </dev/null)"

  if [[ ${in_container} == "$(cat "${ALIAS_FILE}")" ]]; then
    log "    already current, not copying (avoids a needless Postfix reload)"
    return 0
  fi

  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
    cp "${ALIAS_FILE}" "${SERVICE}:${VIRTUAL_DB}"
  log "    copied ${ALIAS_FILE} -> ${SERVICE}:${VIRTUAL_DB}"
  log "    DMS change detection reloads Postfix within a few seconds."
}

# ---------------------------------------------------------------------------

main() {
  preflight "$@"
  wait_for_container
  provision_accounts
  apply_quotas
  install_aliases

  log ""
  log "==> Done. ${created_count} created, ${skipped_count} already existed."
  if (( created_count > 0 )); then
    log "    Passwords are in ${CRED_FILE} (mode 0600). They are not printed here"
    log "    and are not written anywhere else."
  fi
  log ""
  log "    Verify:"
  log "      docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} exec ${SERVICE} setup email list"
  log "      docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} exec ${SERVICE} setup alias list"
}

main "$@"
