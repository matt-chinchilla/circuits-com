#!/usr/bin/env bash
#
# apply-dns.sh — render and apply the P2 mail DNS change set to Route53.
#
#   Zone: Z02960201943UQ96RRIAR  (circuitcenter.ai)
#
# Two modes:
#
#   1) Main cutover batch (mail.circuitcenter.ai A, MX, SPF, DMARC)
#        ./apply-dns.sh <MAIL_EIP>              # dry run: renders + diffs, changes NOTHING
#        ./apply-dns.sh <MAIL_EIP> --confirm    # actually applies
#
#   2) DKIM publish, AFTER docker-mailserver has generated the key
#        ./apply-dns.sh --dkim-file <path> [--selector mail]           # dry run
#        ./apply-dns.sh --dkim-file <path> [--selector mail] --confirm # applies
#
# Nothing mutates without --confirm. The rendered batch and a before/after diff
# are always printed first.
#
# Requires: aws cli v2 (credentials with route53:ChangeResourceRecordSets), jq.
#
set -euo pipefail

ZONE_ID="${ZONE_ID:-Z02960201943UQ96RRIAR}"
ZONE_NAME="circuitcenter.ai."
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BATCH="$HERE/records.json"
DKIM_TEMPLATE="$HERE/dkim-record.json.template"

CONFIRM=0
WAIT=0
MODE=""
EIP=""
DKIM_FILE=""
SELECTOR="mail"
ONLY=""

# --- pretty ------------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
head_() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
die()  { printf '%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
warn() { printf '%swarn:%s %s\n' "$Y" "$N" "$*" >&2; }

usage() {
  cat <<'USAGE'
apply-dns.sh — render and apply the P2 mail DNS change set to Route53.

  Main cutover batch (A / MX / SPF / DMARC):
    ./apply-dns.sh <MAIL_EIP>                                  dry run
    ./apply-dns.sh <MAIL_EIP> --confirm [--wait]               apply

  DKIM publish (only after docker-mailserver generated the key):
    ./apply-dns.sh --dkim-file <path> [--selector mail]            dry run
    ./apply-dns.sh --dkim-file <path> [--selector mail] --confirm  apply

  --confirm    required to mutate anything; without it this is a dry run
  --wait       block until the change reaches INSYNC
  --only TYPE  apply only A, MX or TXT from the batch (see RUNBOOK step 3 vs 9)
  --zone ID    override the hosted zone (default Z02960201943UQ96RRIAR)
USAGE
  exit "${1:-1}"
}

# Captured before parsing consumes "$@", so the --confirm hint can echo it back.
ORIGINAL_ARGS="$(printf '%s ' "$@")"; ORIGINAL_ARGS="${ORIGINAL_ARGS% }"

# --- args --------------------------------------------------------------------
[ $# -gt 0 ] || usage 1
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm)     CONFIRM=1 ;;
    --wait)        WAIT=1 ;;
    --only)        ONLY="${2:-}"; [ -n "$ONLY" ] || die "--only needs a record type (A|MX|TXT)"; shift ;;
    --dkim-file)   MODE="dkim"; DKIM_FILE="${2:-}"; [ -n "$DKIM_FILE" ] || die "--dkim-file needs a path"; shift ;;
    --selector)    SELECTOR="${2:-}"; [ -n "$SELECTOR" ] || die "--selector needs a name"; shift ;;
    --zone)        ZONE_ID="${2:-}"; [ -n "$ZONE_ID" ] || die "--zone needs an id"; shift ;;
    -h|--help)     usage 0 ;;
    -*)            die "unknown flag: $1" ;;
    *)
      [ -z "$EIP" ] || die "unexpected extra argument: $1"
      EIP="$1"; MODE="${MODE:-batch}"
      ;;
  esac
  shift
done
[ -n "$MODE" ] || usage 1

command -v aws >/dev/null || die "aws cli not found"
command -v jq  >/dev/null || die "jq not found"

# --- guards ------------------------------------------------------------------
validate_public_ipv4() {
  local ip="$1"
  [ "$ip" != "MAIL_EIP" ] || die "MAIL_EIP is the placeholder, not an address. Pass the real Elastic IP."
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] \
    || die "not a dotted-quad IPv4 address: '$ip'"
  local o1="${BASH_REMATCH[1]}" o2="${BASH_REMATCH[2]}" o3="${BASH_REMATCH[3]}" o4="${BASH_REMATCH[4]}" o
  for o in "$o1" "$o2" "$o3" "$o4"; do
    [ "$o" -le 255 ] || die "octet out of range in '$ip'"
  done
  case "$ip" in
    0.*|127.*|10.*|192.168.*|169.254.*|255.255.255.255)
      die "'$ip' is not a public address — the mail host needs its public Elastic IP" ;;
  esac
  if [ "$o1" = "172" ] && [ "$o2" -ge 16 ] && [ "$o2" -le 31 ]; then
    die "'$ip' is RFC1918 private — the mail host needs its public Elastic IP"
  fi
}

assert_zone() {
  local name
  name="$(aws route53 get-hosted-zone --id "$ZONE_ID" --query 'HostedZone.Name' --output text 2>/dev/null)" \
    || die "cannot read hosted zone $ZONE_ID (credentials? region? permissions?)"
  [ "$name" = "$ZONE_NAME" ] \
    || die "zone $ZONE_ID is '$name', expected '$ZONE_NAME' — refusing to touch the wrong zone"
  say "zone ${C}${ZONE_ID}${N} verified as ${C}${name}${N}"
}

# Print what is live today for every record the batch touches.
show_before() {
  local rendered="$1"
  head_ "BEFORE (live in Route53 right now)"
  jq -r '.Changes[] | "\(.ResourceRecordSet.Name)\t\(.ResourceRecordSet.Type)"' "$rendered" \
  | while IFS=$'\t' read -r name type; do
      local live
      live="$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
                --query "ResourceRecordSets[?Name=='${name}' && Type=='${type}']" --output json)"
      if [ "$(jq 'length' <<<"$live")" -eq 0 ]; then
        printf '  %s %s  %s(absent — will be CREATED)%s\n' "$name" "$type" "$G" "$N"
      else
        jq -r --arg n "$name" --arg t "$type" \
          '.[0] | "  \($n) \($t)  TTL=\(.TTL)  " + ([.ResourceRecords[].Value] | join(" | "))' <<<"$live"
        printf '  %s^^ will be REPLACED%s\n' "$Y" "$N"
      fi
    done
}

show_after() {
  local rendered="$1"
  head_ "AFTER (what this batch will set)"
  jq -r '.Changes[] |
    "  \(.ResourceRecordSet.Name)  \(.ResourceRecordSet.Type)  TTL=\(.ResourceRecordSet.TTL)  "
    + ([.ResourceRecordSet.ResourceRecords[].Value] | join(" | "))' "$rendered"
  head_ "Rendered change batch"
  cat "$rendered"
}

apply_or_stop() {
  local rendered="$1" label="$2"
  if [ "$CONFIRM" -ne 1 ]; then
    head_ "DRY RUN — nothing was changed."
    say "Re-run with ${B}--confirm${N} to apply:"
    say "    $0 $ORIGINAL_ARGS --confirm"
    return 0
  fi
  head_ "APPLYING ($label)"
  local out id
  out="$(aws route53 change-resource-record-sets \
          --hosted-zone-id "$ZONE_ID" \
          --change-batch "file://$rendered" \
          --output json)"
  id="$(jq -r '.ChangeInfo.Id' <<<"$out")"
  say "submitted: ${C}${id}${N}  status=$(jq -r '.ChangeInfo.Status' <<<"$out")"
  if [ "$WAIT" -eq 1 ]; then
    say "waiting for INSYNC across Route53 (this is propagation inside AWS, not resolver TTL)..."
    aws route53 wait resource-record-sets-changed --id "$id"
    say "${G}INSYNC${N}"
  else
    say "check with: aws route53 get-change --id $id"
  fi
  say ""
  say "Resolver caches still hold the old answers for up to the previous TTL"
  say "(SPF/DMARC were TTL 600). Verify with: ${B}$HERE/verify-mail.sh${N}"
}

TMP=""
cleanup() { [ -n "$TMP" ] && rm -f "$TMP"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Mode 1 — main cutover batch
# ---------------------------------------------------------------------------
if [ "$MODE" = "batch" ]; then
  [ -f "$BATCH" ] || die "missing $BATCH"
  validate_public_ipv4 "$EIP"
  assert_zone

  TMP="$(mktemp -t mail-dns-batch.XXXXXX.json)"
  # Structural substitution: only string leaves *under .Changes* are rewritten, so
  # the JSON shape cannot be corrupted the way a blind sed over the file could, and
  # the human-readable .Comment is left alone.
  jq --arg eip "$EIP" '.Changes |= ((.. | strings) |= gsub("MAIL_EIP"; $eip))' "$BATCH" > "$TMP"

  if jq -e '[.Changes | .. | strings | select(test("MAIL_EIP"))] | length > 0' "$TMP" >/dev/null; then
    die "placeholder survived substitution — aborting"
  fi

  # --only lets the A record go out early (the rDNS request and Let's Encrypt both
  # need it) while MX/SPF/DMARC wait until the container actually answers on 25.
  if [ -n "$ONLY" ]; then
    ONLY="$(tr '[:lower:]' '[:upper:]' <<<"$ONLY")"
    jq --arg t "$ONLY" '.Changes |= map(select(.ResourceRecordSet.Type == $t))' "$TMP" > "$TMP.f" \
      && mv "$TMP.f" "$TMP"
    [ "$(jq '.Changes | length' "$TMP")" -gt 0 ] || die "--only $ONLY matched no records in the batch"
    say "filtered to ${C}${ONLY}${N} records only ($(jq '.Changes | length' "$TMP") change(s))"
  fi

  head_ "P2 mail DNS cutover — mail host $EIP"
  show_before "$TMP"
  show_after "$TMP"

  head_ "Not in this batch (on purpose)"
  say "  DKIM  — the key does not exist until docker-mailserver generates it."
  say "          Publishing a placeholder DKIM TXT is WORSE than publishing none:"
  say "          receivers would find selector '$SELECTOR', fail to verify, and treat"
  say "          every signed message as a DKIM permerror. Publish it after the"
  say "          container is up:  $0 --dkim-file <mail.txt> --confirm"
  say "  PTR   — not a Route53 record. It is set by AWS on the Elastic IP via the"
  say "          port-25 unblock / rDNS request form. See RUNBOOK.md step 4."

  apply_or_stop "$TMP" "main cutover batch"
  exit 0
fi

# ---------------------------------------------------------------------------
# Mode 2 — DKIM publish
# ---------------------------------------------------------------------------
if [ "$MODE" = "dkim" ]; then
  [ -f "$DKIM_TEMPLATE" ] || die "missing $DKIM_TEMPLATE"
  [ -f "$DKIM_FILE" ]     || die "no such DKIM key file: $DKIM_FILE"
  [[ "$SELECTOR" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]] || die "bad selector: '$SELECTOR'"

  raw="$(cat "$DKIM_FILE")"

  # docker-mailserver writes BIND-style output with the key split across several
  # quoted strings. Concatenating everything inside double quotes reconstructs the
  # value and naturally drops the trailing `; ----- DKIM key ...` comment.
  if printf '%s' "$raw" | grep -q '"'; then
    value="$(printf '%s' "$raw" | grep -o '"[^"]*"' | sed 's/^"//; s/"$//' | tr -d '\n\r')"
  else
    value="$(printf '%s' "$raw" | tr -d ' \t\n\r')"
  fi

  # A bare base64 blob (no v=DKIM1 wrapper) is accepted and wrapped.
  case "$value" in
    v=DKIM1*|V=DKIM1*) ;;
    *) value="v=DKIM1; h=sha256; k=rsa; p=$value" ;;
  esac

  # Refuse to publish something that is not a usable key.
  pubkey="${value##*p=}"
  pubkey="${pubkey%%;*}"
  pubkey="$(printf '%s' "$pubkey" | tr -d ' ')"
  [ "${#pubkey}" -ge 100 ] \
    || die "extracted DKIM p= is only ${#pubkey} chars — that is not a real key. Parsed from: $DKIM_FILE"
  [[ "$pubkey" =~ ^[A-Za-z0-9+/=]+$ ]] \
    || die "extracted DKIM p= is not base64 — parsed the wrong thing out of $DKIM_FILE"
  [ "${#value}" -le 3900 ] || die "DKIM value is ${#value} chars, over the Route53 per-record limit"

  # A 2048-bit key is ~400 base64 chars. A single DNS character-string caps at 255,
  # so the value MUST be emitted as several quoted strings inside one Value. Getting
  # this wrong is the classic "DKIM record published but never verifies" failure.
  chunked=""
  rest="$value"
  while [ -n "$rest" ]; do
    chunked+="\"${rest:0:255}\" "
    rest="${rest:255}"
  done
  chunked="${chunked% }"

  assert_zone

  TMP="$(mktemp -t mail-dns-dkim.XXXXXX.json)"
  jq --arg sel "$SELECTOR" --arg val "$chunked" \
    '.Changes[0].ResourceRecordSet.Name = ($sel + "._domainkey.circuitcenter.ai.")
     | .Changes[0].ResourceRecordSet.ResourceRecords[0].Value = $val' \
    "$DKIM_TEMPLATE" > "$TMP"

  head_ "DKIM publish — selector '$SELECTOR', key from $DKIM_FILE"
  say "key length: ${#pubkey} base64 chars; TXT value split into $(( (${#value} + 254) / 255 )) character-string(s)"
  show_before "$TMP"
  show_after "$TMP"

  head_ "Note"
  say "  The three existing SES DKIM CNAMEs use token selectors"
  say "  (oxnfmck…, v337t2c…, zkfvj4j…._domainkey) and do NOT collide with '$SELECTOR'."
  say "  Both signing paths coexist: SES signs what the site relays, this key signs"
  say "  what the mail host sends directly."

  apply_or_stop "$TMP" "DKIM selector $SELECTOR"
  exit 0
fi

usage 1
