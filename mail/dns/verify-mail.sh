#!/usr/bin/env bash
#
# verify-mail.sh — post-cutover verification for circuitcenter.ai mail.
#
# Read-only. Sends no mail. Safe to run repeatedly, from anywhere.
#
#   ./verify-mail.sh                          # check everything
#   ./verify-mail.sh --ip 44.206.18.109       # also assert the A record points here
#   ./verify-mail.sh --selector mail          # DKIM selector to look for (default: mail)
#   ./verify-mail.sh --resolver 8.8.8.8       # query a specific resolver (default: system)
#   ./verify-mail.sh --skip-relay             # skip the open-relay probe
#
# Exit code: 0 if no FAILs, 1 otherwise. WARNs never fail the run.
#
# NOTE: deliberately NOT `set -e`. This is a checker; individual probes are
# expected to fail and each one is handled explicitly.
#
set -uo pipefail

DOMAIN="circuitcenter.ai"
MAIL_HOST="mail.${DOMAIN}"
EXPECT_MX_PRIO=10
SELECTOR="mail"
RESOLVER=""
EXPECT_IP=""
SKIP_RELAY=0
TIMEOUT=10

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)         EXPECT_IP="${2:-}"; shift ;;
    --selector)   SELECTOR="${2:-}"; shift ;;
    --resolver)   RESOLVER="${2:-}"; shift ;;
    --skip-relay) SKIP_RELAY=1 ;;
    --timeout)    TIMEOUT="${2:-}"; shift ;;
    -h|--help)    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# --- output ------------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; D=""; N=""
fi
n_pass=0; n_warn=0; n_fail=0
FAILED_NAMES=()

pass() { n_pass=$((n_pass+1)); printf '  %sPASS%s  %-34s %s\n' "$G" "$N" "$1" "${2:-}"; }
warn() { n_warn=$((n_warn+1)); printf '  %sWARN%s  %-34s %s\n' "$Y" "$N" "$1" "${2:-}"; }
fail() { n_fail=$((n_fail+1)); FAILED_NAMES+=("$1"); printf '  %sFAIL%s  %-34s %s\n' "$R" "$N" "$1" "${2:-}"; }
note() { printf '        %s%s%s\n' "$D" "$1" "$N"; }
section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

# --- dns helpers -------------------------------------------------------------
command -v dig >/dev/null || { echo "dig is required (apt install dnsutils)" >&2; exit 2; }
DIGAT=()
[ -n "$RESOLVER" ] && DIGAT=("@$RESOLVER")

dq()  { dig +short "${DIGAT[@]}" "$@" 2>/dev/null; }
# One TXT record per line, quotes stripped, split character-strings rejoined.
txt() { dq TXT "$1" | sed 's/" "//g; s/^"//; s/"$//'; }

port_open() {
  timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

printf '%smail verification — %s%s\n' "$B" "$DOMAIN" "$N"
printf '%s%s%s\n' "$D" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')  resolver=${RESOLVER:-system}  selector=${SELECTOR}" "$N"

# =============================================================================
section "1. DNS"
# =============================================================================

MAIL_IP="$(dq A "$MAIL_HOST" | grep -E '^[0-9.]+$' | head -1)"
if [ -z "$MAIL_IP" ]; then
  fail "A $MAIL_HOST" "does not resolve"
else
  if [ -n "$EXPECT_IP" ] && [ "$MAIL_IP" != "$EXPECT_IP" ]; then
    fail "A $MAIL_HOST" "resolves to $MAIL_IP, expected $EXPECT_IP"
  else
    pass "A $MAIL_HOST" "$MAIL_IP"
  fi
fi

MX_LINE="$(dq MX "$DOMAIN" | head -1)"
if [ -z "$MX_LINE" ]; then
  fail "MX $DOMAIN" "no MX record — inbound mail cannot be delivered"
else
  MX_PRIO="$(awk '{print $1}' <<<"$MX_LINE")"
  MX_TGT="$(awk '{print $2}' <<<"$MX_LINE")"
  if [ "${MX_TGT%.}" != "$MAIL_HOST" ]; then
    fail "MX $DOMAIN" "points at ${MX_TGT%.}, expected $MAIL_HOST"
  elif [ "$MX_PRIO" != "$EXPECT_MX_PRIO" ]; then
    warn "MX $DOMAIN" "priority $MX_PRIO, expected $EXPECT_MX_PRIO"
  else
    pass "MX $DOMAIN" "$MX_PRIO ${MX_TGT%.}"
  fi
fi

# RFC 2181 §10.3: an MX target must be a hostname with an address record, never a CNAME.
if [ -n "$(dq CNAME "$MAIL_HOST")" ]; then
  fail "MX target is not a CNAME" "$MAIL_HOST is a CNAME — illegal as an MX target"
else
  [ -n "$MAIL_IP" ] && pass "MX target is not a CNAME" "A record, per RFC 2181"
fi

# --- SPF ---
mapfile -t SPF_ALL < <(txt "$DOMAIN" | grep -i '^v=spf1')
if [ "${#SPF_ALL[@]}" -eq 0 ]; then
  fail "SPF present" "no v=spf1 TXT at $DOMAIN"
elif [ "${#SPF_ALL[@]}" -gt 1 ]; then
  fail "SPF single record" "${#SPF_ALL[@]} v=spf1 records — this is a permerror, senders will fail SPF"
else
  SPF="${SPF_ALL[0]}"
  pass "SPF present" "$SPF"
  if grep -q 'include:amazonses.com' <<<"$SPF"; then
    pass "SPF keeps SES" "include:amazonses.com"
  else
    fail "SPF keeps SES" "include:amazonses.com missing — SES-relayed mail will fail SPF"
  fi
  if [ -n "$MAIL_IP" ]; then
    if grep -qF "ip4:$MAIL_IP" <<<"$SPF" || grep -qF "a:$MAIL_HOST" <<<"$SPF"; then
      pass "SPF covers the mail host" "$MAIL_IP authorised"
    else
      fail "SPF covers the mail host" "neither ip4:$MAIL_IP nor a:$MAIL_HOST in the record"
    fi
  fi
  # Each include/a/mx/ptr/exists costs a DNS lookup; >10 is a permerror.
  lookups=$(grep -oE '(^| )(include:|a:|a |mx:|mx |ptr|exists:)' <<<"$SPF" | wc -l)
  if [ "$lookups" -gt 10 ]; then
    fail "SPF lookup budget" "$lookups mechanisms, RFC 7208 caps at 10"
  else
    pass "SPF lookup budget" "$lookups of 10 DNS-lookup mechanisms"
  fi
fi

# --- DMARC ---
DMARC="$(txt "_dmarc.${DOMAIN}" | grep -i '^v=DMARC1' | head -1)"
if [ -z "$DMARC" ]; then
  fail "DMARC present" "no v=DMARC1 TXT at _dmarc.$DOMAIN"
else
  pass "DMARC present" "$DMARC"
  grep -qiE '(^|;)[[:space:]]*p=' <<<"$DMARC" \
    && pass "DMARC policy tag" "$(grep -oiE 'p=[a-z]+' <<<"$DMARC" | head -1)" \
    || fail "DMARC policy tag" "no p= tag — the record is ignored without it"
  if grep -qi 'rua=' <<<"$DMARC"; then
    pass "DMARC rua" "$(grep -oiE 'rua=[^;]+' <<<"$DMARC" | head -1)"
    # Reports to a different domain need an authorisation record at the destination.
    rua_dom="$(grep -oiE 'rua=mailto:[^;,[:space:]]+' <<<"$DMARC" | head -1 | sed 's/.*@//')"
    if [ -n "$rua_dom" ] && [ "$rua_dom" != "$DOMAIN" ]; then
      warn "DMARC rua is external" "$rua_dom needs ${DOMAIN}._report._dmarc.$rua_dom to authorise it"
    fi
  else
    warn "DMARC rua" "no rua= — you will get no aggregate reports, so p= can never be tightened safely"
  fi
fi

# --- DKIM ---
DKIM="$(txt "${SELECTOR}._domainkey.${DOMAIN}" | grep -i 'v=DKIM1' | head -1)"
if [ -z "$DKIM" ]; then
  fail "DKIM $SELECTOR" "no TXT at ${SELECTOR}._domainkey.${DOMAIN} — publish it with apply-dns.sh --dkim-file"
else
  dk_p="$(sed 's/.*p=//; s/;.*//; s/[[:space:]]//g' <<<"$DKIM")"
  if [ "${#dk_p}" -lt 100 ]; then
    fail "DKIM $SELECTOR" "p= is only ${#dk_p} chars — key looks truncated or is a revocation"
  else
    pass "DKIM $SELECTOR" "${#dk_p}-char public key"
  fi
fi

# SES signs everything the site relays. Widening SPF must not have disturbed these.
SES_DKIM_TOKENS=(
  oxnfmckncbmegz4tehxg6s7qvxnqe4ua
  v337t2cgfi66u2p56hvooosbtgeox2lv
  zkfvj4jdhayyzbc4q3clszwwddauepyj
)
ses_ok=0
for tok in "${SES_DKIM_TOKENS[@]}"; do
  [ -n "$(dq CNAME "${tok}._domainkey.${DOMAIN}")" ] && ses_ok=$((ses_ok+1))
done
if [ "$ses_ok" -eq "${#SES_DKIM_TOKENS[@]}" ]; then
  pass "SES DKIM CNAMEs intact" "$ses_ok/${#SES_DKIM_TOKENS[@]} token selectors resolve"
else
  fail "SES DKIM CNAMEs intact" "only $ses_ok/${#SES_DKIM_TOKENS[@]} resolve — SES-relayed mail will fail DKIM"
fi

# --- PTR ---
if [ -n "$MAIL_IP" ]; then
  PTR="$(dq -x "$MAIL_IP" | head -1)"
  if [ -z "$PTR" ]; then
    warn "PTR (reverse DNS)" "no PTR for $MAIL_IP"
  elif [ "${PTR%.}" = "$MAIL_HOST" ]; then
    pass "PTR (reverse DNS)" "${PTR%.}"
  else
    warn "PTR (reverse DNS)" "${PTR%.} — AWS default, rDNS request not granted yet"
    note "Only matters for direct port-25 delivery. Outbound relays via SES, which uses"
    note "its own PTR, so this does not block sending. See RUNBOOK.md step 4."
  fi
fi

# =============================================================================
section "2. Reachability"
# =============================================================================

declare -A PORT_STATE=()
check_port() {
  local port="$1" label="$2"
  if [ -z "$MAIL_IP" ]; then PORT_STATE[$port]=skip; return; fi
  if port_open "$MAIL_HOST" "$port"; then
    PORT_STATE[$port]=open; pass "port $port ($label)" "open"
  else
    PORT_STATE[$port]=closed
  fi
}
check_port 25  "SMTP inbound"
check_port 465 "SMTPS submission"
check_port 587 "submission"
check_port 993 "IMAPS"

# Port 25 needs a nuanced verdict: many ISPs block *outbound* 25 from client
# networks, so an unreachable 25 from a workstation is often a false negative.
if [ "${PORT_STATE[25]:-skip}" = "closed" ]; then
  if [ "${PORT_STATE[587]:-}" = "open" ]; then
    warn "port 25 (SMTP inbound)" "unreachable, but 587 is open — host is up"
    note "587 open + 25 closed means the block is specific to port 25. Two causes:"
    note "  (a) your own network/ISP blocks outbound 25 — most likely from a workstation;"
    note "  (b) the mail host's security group does not allow 25 from 0.0.0.0/0."
    note "Disambiguate from outside your network:"
    note "  ssh to the web box and run:  nc -vz $MAIL_HOST 25"
    note "  or check the SG:  aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=25"
    note "This is NOT the AWS port-25 unblock — that throttles EGRESS from EC2, not inbound."
  else
    fail "port 25 (SMTP inbound)" "unreachable, and so is 587 — host down or SG wrong"
  fi
fi
for p in 465 587 993; do
  [ "${PORT_STATE[$p]:-}" = "closed" ] && fail "port $p" "unreachable"
done

# =============================================================================
section "3. TLS"
# =============================================================================

tls_check() {
  local port="$1" starttls="$2" label="$3"
  if [ "${PORT_STATE[$port]:-}" != "open" ]; then
    warn "TLS $label ($port)" "skipped, port not reachable"; return
  fi
  local args=(-connect "${MAIL_HOST}:${port}" -servername "$MAIL_HOST" -verify_hostname "$MAIL_HOST" -verify 6)
  [ -n "$starttls" ] && args+=(-starttls "$starttls")
  local out
  out="$(timeout "$TIMEOUT" openssl s_client "${args[@]}" </dev/null 2>&1)"

  local vline
  vline="$(grep -m1 'Verify return code:' <<<"$out")"
  local pem
  pem="$(sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' <<<"$out")"

  if [ -z "$pem" ]; then
    fail "TLS $label ($port)" "no certificate presented ${vline:+($vline)}"; return
  fi
  if ! grep -q 'Verify return code: 0 (ok)' <<<"$out"; then
    fail "TLS $label ($port)" "${vline:-verification failed}"
    case "$vline" in
      *self*signed*) note "Still the container's self-signed cert — Let's Encrypt has not issued yet." ;;
      *hostname*|*Hostname*) note "Cert does not cover $MAIL_HOST." ;;
    esac
    return
  fi
  local enddate subj
  enddate="$(openssl x509 -noout -enddate <<<"$pem" 2>/dev/null | cut -d= -f2)"
  subj="$(openssl x509 -noout -subject <<<"$pem" 2>/dev/null | sed 's/^subject= *//')"
  if openssl x509 -checkend 604800 -noout <<<"$pem" >/dev/null 2>&1; then
    pass "TLS $label ($port)" "valid for $MAIL_HOST, expires $enddate"
  else
    warn "TLS $label ($port)" "valid but expires within 7 days — $enddate"
    note "subject: $subj"
  fi
}

tls_check 587 smtp  "STARTTLS submission"
tls_check 25  smtp  "STARTTLS inbound"
tls_check 465 ""    "implicit SMTPS"
tls_check 993 ""    "implicit IMAPS"

if port_open "$MAIL_HOST" 443; then
  PORT_STATE[443]=open
  tls_check 443 "" "webmail HTTPS"
else
  warn "webmail HTTPS (443)" "not reachable — Roundcube at https://$MAIL_HOST will not load"
fi

# =============================================================================
section "4. SMTP behaviour"
# =============================================================================

smtp_probe_port=""
for p in 25 587; do
  [ "${PORT_STATE[$p]:-}" = "open" ] && { smtp_probe_port="$p"; break; }
done

if [ -z "$smtp_probe_port" ]; then
  fail "SMTP banner" "no reachable SMTP port to probe"
elif ! command -v python3 >/dev/null; then
  warn "SMTP banner" "python3 not available for the SMTP conversation"
else
  probe="$(timeout $((TIMEOUT * 3)) python3 - "$MAIL_HOST" "$smtp_probe_port" "$DOMAIN" <<'PY' 2>/dev/null
import socket, sys
host, port, domain = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    s = socket.create_connection((host, port), timeout=10)
except Exception as e:
    print("ERROR=" + str(e)); sys.exit(0)
s.settimeout(10)
f = s.makefile("rb")

def read():
    lines = []
    while True:
        raw = f.readline()
        if not raw:
            break
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        lines.append(line)
        if len(line) >= 4 and line[3] == " ":
            break
    return lines

def cmd(c):
    s.sendall((c + "\r\n").encode())
    return read()

try:
    banner = read()
    print("BANNER=" + (banner[0] if banner else ""))
    ehlo = cmd("EHLO relay-probe.invalid")
    print("EHLO=" + (ehlo[-1] if ehlo else ""))
    print("EHLOCAPS=" + "|".join(l[4:] for l in ehlo))
    # Relay probe: an external sender asking for an external recipient. A correctly
    # configured server MUST refuse. Nothing is ever sent - we stop at RCPT.
    m = cmd("MAIL FROM:<relay-probe@example.com>")
    print("MAIL=" + (m[-1] if m else ""))
    r = cmd("RCPT TO:<relay-probe@example.net>")
    print("RCPT=" + (r[-1] if r else ""))
    cmd("QUIT")
except Exception as e:
    print("ERROR=" + str(e))
finally:
    try:
        s.close()
    except Exception:
        pass
PY
)"
  banner="$(grep -m1 '^BANNER=' <<<"$probe" | cut -d= -f2-)"
  ehlocaps="$(grep -m1 '^EHLOCAPS=' <<<"$probe" | cut -d= -f2-)"
  rcpt="$(grep -m1 '^RCPT=' <<<"$probe" | cut -d= -f2-)"
  perr="$(grep -m1 '^ERROR=' <<<"$probe" | cut -d= -f2-)"

  if [ -n "$perr" ] && [ -z "$banner" ]; then
    fail "SMTP banner" "$perr"
  elif [ -z "$banner" ]; then
    fail "SMTP banner" "no 220 greeting on port $smtp_probe_port"
  elif [[ "$banner" == 220* ]]; then
    pass "SMTP banner (port $smtp_probe_port)" "$banner"
    grep -qi "$MAIL_HOST" <<<"$banner" \
      && pass "banner announces the host" "matches $MAIL_HOST" \
      || warn "banner announces the host" "does not contain $MAIL_HOST — myhostname may be wrong"
    note "A banner whose name disagrees with the PTR and the HELO name costs reputation."
  else
    fail "SMTP banner" "unexpected greeting: $banner"
  fi

  if [ -n "$ehlocaps" ]; then
    grep -qi 'STARTTLS' <<<"$ehlocaps" \
      && pass "STARTTLS advertised" "on port $smtp_probe_port" \
      || warn "STARTTLS advertised" "not offered on port $smtp_probe_port"
  fi

  if [ "$SKIP_RELAY" -eq 1 ]; then
    note "open-relay probe skipped (--skip-relay)"
  elif [ -z "$rcpt" ]; then
    warn "open relay refused" "could not complete the probe — check manually"
  else
    case "$rcpt" in
      5*) pass "open relay refused" "RCPT rejected: $rcpt" ;;
      2*) fail "OPEN RELAY" "server accepted an external->external RCPT: $rcpt"
          note "CRITICAL. This host will be abused for spam within hours and blacklisted."
          note "Fix Postfix smtpd_recipient_restrictions before leaving it exposed." ;;
      4*) warn "open relay refused" "temporary rejection ($rcpt) — greylisting? re-run to confirm" ;;
      *)  warn "open relay refused" "unexpected RCPT response: $rcpt" ;;
    esac
  fi
fi

# =============================================================================
section "Summary"
# =============================================================================
printf '  %s%d passed%s   %s%d warnings%s   %s%d failed%s\n' \
  "$G" "$n_pass" "$N" "$Y" "$n_warn" "$N" "$R" "$n_fail" "$N"
if [ "$n_fail" -gt 0 ]; then
  printf '\n  %sFailed:%s\n' "$R" "$N"
  for f in "${FAILED_NAMES[@]}"; do printf '    - %s\n' "$f"; done
fi

# =============================================================================
section "Sending a real test message (not automated — needs credentials)"
# =============================================================================
cat <<EOF
  None of the checks above prove a message actually flows. Do these three by hand
  once the checks are green.

  1. INBOUND — the real proof that MX + Postfix + Dovecot work end to end.
       From an external account (Gmail/Outlook), send to  matthew@${DOMAIN}
       Then open  https://${MAIL_HOST}  and confirm it arrived.
       If it does not, on the mail box:  docker logs -f mailserver | grep -i 'postfix\\|dovecot'

  2. OUTBOUND via the mail host — proves submission + SES relay.
       swaks is the cleanest tool (apt install swaks):
         swaks --server ${MAIL_HOST}:587 --tls \\
               --auth LOGIN --auth-user matthew@${DOMAIN} \\
               --from matthew@${DOMAIN} --to <your-personal-address> \\
               --header 'Subject: circuitcenter mail test'
       It will prompt for the password — do not put it on the command line, it
       lands in your shell history.

  3. AUTHENTICATION SCORING — proves SPF, DKIM and DMARC all align.
       Send from matthew@${DOMAIN} to the address shown at https://www.mail-tester.com
       (aim for 10/10), or send to any Gmail address and use
       "Show original" to read the SPF / DKIM / DMARC verdicts directly.

  Then, over the following week:
    - DMARC aggregate reports arrive as XML at no-reply@${DOMAIN}. Read a few.
    - Only once they show all legitimate sources passing, tighten
      DMARC p=none -> p=quarantine -> p=reject. See RUNBOOK.md step 9.
EOF

[ "$n_fail" -eq 0 ] || exit 1
exit 0
