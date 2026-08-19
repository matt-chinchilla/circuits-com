#!/usr/bin/env bash
# Push the webmail skin + plugins from this checkout to the mail server.
#
#   ./mail-update.sh            # skin + both plugins
#   ./mail-update.sh --skin     # skin only (the common case — CSS tweaks)
#   ./mail-update.sh --plugins  # cccalendar + ccsignature only
#   ./mail-update.sh --dry-run  # show what WOULD change, copy nothing
#
# The mail box is a SEPARATE instance from the web server (mail.circuitcenter.ai,
# i-0137a3f25f5c7bec5) and its files are COPIES, not a git checkout — hence this
# script rather than a git pull. All three targets are read-only bind mounts
# (docker-compose.webmail.yml), so a CSS/PHP change is live on the next request:
# no container restart, just a hard refresh in the browser.
#
# SSH to this box is IP-allowlisted. If your ISP has moved you since the rule
# was written, the preflight below says so and prints the exact command to fix
# it — it does NOT change the firewall for you.
set -euo pipefail

MAIL_HOST="mail.circuitcenter.ai"
MAIL_INSTANCE="i-0137a3f25f5c7bec5"
MAIL_SG="sg-0edd2c8ed27550187"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$REPO_DIR/mail/roundcube-skin/circuitcenter"
PLUGIN_SRC="$REPO_DIR/mail/roundcube-plugins"
DEST_SKIN="/opt/circuits-mail/skin/circuitcenter"
DEST_PLUGINS="/opt/circuits-mail/plugins"

MODE="${1:---all}"
DRY=""
[[ "$MODE" == "--dry-run" ]] && { DRY="yes"; MODE="--all"; }

MAIL_IP="$(dig +short "$MAIL_HOST" | tail -1)"
[[ -n "$MAIL_IP" ]] || { echo "!! $MAIL_HOST does not resolve"; exit 1; }

push_key() {
  # Instance Connect keys live ~60s — push one right before each ssh/scp.
  aws ec2-instance-connect send-ssh-public-key \
    --instance-id "$MAIL_INSTANCE" --instance-os-user ec2-user \
    --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" --output text > /dev/null
}
SSH_OPTS=(-o ConnectTimeout=8 -o StrictHostKeyChecking=no)

# ── Preflight: can we even reach it? ────────────────────────────────────────
push_key 2>/dev/null || true
if ! ssh "${SSH_OPTS[@]}" "ec2-user@$MAIL_IP" true 2>/dev/null; then
  MY_IP="$(curl -s --max-time 10 https://checkip.amazonaws.com || echo unknown)"
  cat <<EOF
!! Cannot SSH to $MAIL_HOST ($MAIL_IP).

   SSH on that box is allowlisted per-IP and this machine is $MY_IP.
   Current rules:
$(aws ec2 describe-security-groups --group-ids "$MAIL_SG" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' \
    --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/     /')

   If $MY_IP is not listed, authorize it (this OPENS A FIREWALL PORT — your
   call, not the script's), then re-run:

     aws ec2 authorize-security-group-ingress --group-id $MAIL_SG \\
       --protocol tcp --port 22 --cidr $MY_IP/32

   Revoke it the same way with 'revoke-security-group-ingress' when done.
EOF
  exit 1
fi

copy() { # copy <label> <local dir> <remote dest dir>
  local label="$1" src="$2" dest="$3"
  [[ -d "$src" ]] || { echo "   skip $label (no $src)"; return; }
  if [[ -n "$DRY" ]]; then
    push_key
    echo "== $label — would change:"
    rsync -rin --delete -e "ssh ${SSH_OPTS[*]}" --rsync-path="sudo rsync" \
      "$src/" "ec2-user@$MAIL_IP:$dest/" | sed 's/^/     /' || echo "     (rsync unavailable on the box — full copy)"
    return
  fi
  echo "== $label"
  push_key
  # Stage in /tmp (ec2-user-writable), then sudo-move into place: the mounts
  # are root-owned and scp cannot sudo.
  local stage="/tmp/mailupd-$(basename "$dest")"
  ssh "${SSH_OPTS[@]}" "ec2-user@$MAIL_IP" "rm -rf $stage && mkdir -p $stage"
  push_key
  scp -q -r "${SSH_OPTS[@]}" "$src/." "ec2-user@$MAIL_IP:$stage/"
  push_key
  ssh "${SSH_OPTS[@]}" "ec2-user@$MAIL_IP" \
    "sudo mkdir -p $dest && sudo cp -r $stage/. $dest/ && sudo chown -R root:root $dest && rm -rf $stage && echo '   ok'"
}

case "$MODE" in
  --skin)    copy "skin" "$SRC" "$DEST_SKIN" ;;
  --plugins)
    copy "cccalendar"  "$PLUGIN_SRC/cccalendar"  "$DEST_PLUGINS/cccalendar"
    copy "ccsignature" "$PLUGIN_SRC/ccsignature" "$DEST_PLUGINS/ccsignature"
    ;;
  --all)
    copy "skin" "$SRC" "$DEST_SKIN"
    copy "cccalendar"  "$PLUGIN_SRC/cccalendar"  "$DEST_PLUGINS/cccalendar"
    copy "ccsignature" "$PLUGIN_SRC/ccsignature" "$DEST_PLUGINS/ccsignature"
    ;;
  *) echo "usage: mail-update.sh [--skin|--plugins|--all|--dry-run]"; exit 2 ;;
esac

[[ -n "$DRY" ]] && { echo "dry run — nothing copied."; exit 0; }

# NOTE: config.inc.php files are gitignored and live only on the box — this
# script never touches them, so a deploy cannot clobber a secret.
echo
echo "done. Read-only bind mounts, so it is already live —"
echo "hard-refresh https://$MAIL_HOST (Ctrl+Shift+R) to drop the cached CSS."
