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
# Access goes through an EC2 Instance Connect ENDPOINT (eice-08c30f642437bb8f5),
# not a firewall hole: the CLI opens a tunnel to a private-network listener and
# AWS authorizes it with your IAM identity. That is why this works from any
# network and does not break when your ISP rotates your address — the previous
# per-IP allowlist did both. Requires `ec2-instance-connect:OpenTunnel`.
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

# Sanity only — routing is the tunnel's job, not DNS's. A host that stops
# resolving still means something is wrong worth saying out loud.
dig +short "$MAIL_HOST" > /dev/null 2>&1 || echo "note: $MAIL_HOST did not resolve (the tunnel does not need it)"

EICE_ID="eice-08c30f642437bb8f5"

push_key() {
  # Instance Connect keys live ~60s — push one right before each ssh/scp.
  aws ec2-instance-connect send-ssh-public-key \
    --instance-id "$MAIL_INSTANCE" --instance-os-user ec2-user \
    --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" --output text > /dev/null
}

# Every hop rides the endpoint: ProxyCommand streams the session over the
# tunnel, so ssh/scp never touch the box's public address at all.
PROXY="aws ec2-instance-connect open-tunnel --instance-connect-endpoint-id $EICE_ID --instance-id $MAIL_INSTANCE"
SSH_OPTS=(-o ConnectTimeout=15 -o StrictHostKeyChecking=no -o "ProxyCommand=$PROXY")
TARGET="ec2-user@$MAIL_INSTANCE"   # a name for ssh; the tunnel does the routing

# ── Preflight ───────────────────────────────────────────────────────────────
push_key 2>/dev/null || true
if ! ssh "${SSH_OPTS[@]}" "$TARGET" true 2>/dev/null; then
  cat <<EOF
!! Cannot reach $MAIL_HOST through the Instance Connect endpoint ($EICE_ID).

   Nothing here is about your IP address — the endpoint replaced per-IP
   allowlisting. Check, in order:

     1. endpoint is up:
        aws ec2 describe-instance-connect-endpoints \\
          --instance-connect-endpoint-ids $EICE_ID \\
          --query 'InstanceConnectEndpoints[0].State' --output text
        (want: create-complete)

     2. your IAM identity may open a tunnel:
        needs ec2-instance-connect:OpenTunnel + ec2:DescribeInstances

     3. the instance is running:
        aws ec2 describe-instances --instance-ids $MAIL_INSTANCE \\
          --query 'Reservations[0].Instances[0].State.Name' --output text
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
      "$src/" "$TARGET:$dest/" | sed 's/^/     /' || echo "     (rsync unavailable on the box — full copy)"
    return
  fi
  echo "== $label"
  push_key
  # Stage in /tmp (ec2-user-writable), then sudo-move into place: the mounts
  # are root-owned and scp cannot sudo.
  local stage="/tmp/mailupd-$(basename "$dest")"
  ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf $stage && mkdir -p $stage"
  push_key
  scp -q -r "${SSH_OPTS[@]}" "$src/." "$TARGET:$stage/"
  push_key
  ssh "${SSH_OPTS[@]}" "$TARGET" \
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
