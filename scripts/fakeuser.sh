#!/usr/bin/env bash
# circuits --fakeuser — raise/lower the fake-presence count in the admin pill.
#
#   circuits --fakeuser --up [N]     add N fakes (default 1, DB-capped at 10)
#   circuits --fakeuser --down [N]   remove N fakes; BARE --down clears ALL
#   circuits --fakeuser --status     show the current count
#   ... --prod                       target the live EC2 box instead of local
#
# Writes the presence_fakes singleton (migration 034) via psql — the api only
# ever READS it, so there is no endpoint and no auth surface. Fakes are the
# FICTIONAL roster in api/app/routes/admin_presence.py (FAKE_PRESENCE_ROSTER);
# they are visible to every admin viewer (demo door included) while count > 0.
set -euo pipefail

INSTANCE_ID="i-0d456bd12719e2176"
EIP="100.55.235.167"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROD=0 ACTION="" N=""
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --up|--down|--status) ACTION="${arg#--}" ;;
    [1-9]|10) N="$arg" ;;
    *) echo "usage: circuits --fakeuser --up [N] | --down [N] | --status  [--prod]  (N: 1-10)" >&2; exit 2 ;;
  esac
done
[ -n "$ACTION" ] || { echo "usage: circuits --fakeuser --up [N] | --down [N] | --status  [--prod]" >&2; exit 2; }

case "$ACTION" in
  up)
    N="${N:-1}"
    SQL="INSERT INTO presence_fakes (id, count, updated_at) VALUES (1, LEAST($N, 10), now())
         ON CONFLICT (id) DO UPDATE SET count = LEAST(presence_fakes.count + $N, 10), updated_at = now()
         RETURNING count;" ;;
  down)
    if [ -n "$N" ]; then
      SQL="UPDATE presence_fakes SET count = GREATEST(count - $N, 0), updated_at = now() WHERE id = 1 RETURNING count;"
    else
      # Bare --down kills ALL fake users (owner-specified default).
      SQL="UPDATE presence_fakes SET count = 0, updated_at = now() WHERE id = 1 RETURNING count;"
    fi ;;
  status)
    SQL="SELECT count FROM presence_fakes WHERE id = 1;" ;;
esac

run_sql() {
  if [ "$PROD" = 1 ]; then
    # Instance Connect keys live 60s — push right before the ssh (pull-prod-data.sh pattern).
    aws ec2-instance-connect send-ssh-public-key --instance-id "$INSTANCE_ID" \
      --instance-os-user ec2-user \
      --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" --output text > /dev/null
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "ec2-user@$EIP" \
      "cd /opt/circuits-com && sudo docker compose exec -T db psql -U circuits -d circuits -tAq" <<< "$SQL"
  else
    docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db psql -U circuits -d circuits -tAq <<< "$SQL"
  fi
}

COUNT="$(run_sql | head -n1 | tr -d '[:space:]')"
WHERE=$([ "$PROD" = 1 ] && echo "prod" || echo "local")
if [ -z "$COUNT" ]; then
  echo "fakeuser[$WHERE]: presence_fakes row missing — run migrations first (alembic 034)." >&2
  exit 1
fi
echo "fakeuser[$WHERE]: $COUNT fake user(s) online"
