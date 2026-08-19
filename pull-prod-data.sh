#!/usr/bin/env bash
# Pull production data into the LOCAL dev DB. Two modes, both safe/idempotent:
#
#   ./pull-prod-data.sh              # both modes
#   ./pull-prod-data.sh --reporting  # page_views + messages (replace local copies)
#   ./pull-prod-data.sh --catalog    # suppliers/parts/listings/breaks by natural
#                                    # keys (additive upsert — local-only rows
#                                    # survive; prod is NEVER written)
#
# Reporting = the standing post-deploy rule (analytics/messages are prod-truth).
# Catalog   = after import runs on prod, so local mirrors the live inventory.
# Requires: AWS CLI (Instance Connect), ~/.ssh/id_ed25519, local stack running.
set -euo pipefail

INSTANCE_ID="i-0d456bd12719e2176"
EIP="100.55.235.167"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

push_key() {
  # Instance Connect keys live 60s — push right before each ssh use.
  aws ec2-instance-connect send-ssh-public-key --instance-id "$INSTANCE_ID" \
    --instance-os-user ec2-user \
    --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" --output text > /dev/null
}
SSH=(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "ec2-user@$EIP")

MODE="${1:---all}"

if [[ "$MODE" == "--all" || "$MODE" == "--reporting" ]]; then
  echo "==> reporting pull (page_views + messages)"
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T db \
    pg_dump -U circuits -d circuits --data-only -t page_views -t messages" \
    > "$TMP/reporting.sql"
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits -c "TRUNCATE page_views, messages;" > /dev/null
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits < "$TMP/reporting.sql" > /dev/null
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits -c \
    "SELECT count(*) AS page_views FROM page_views; SELECT count(*) AS messages FROM messages;"
fi

if [[ "$MODE" == "--all" || "$MODE" == "--catalog" ]]; then
  echo "==> catalog pull (suppliers/parts/listings/price breaks, natural keys)"
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T api python -" \
    < "$REPO_DIR/scripts/catalog_export.py" > "$TMP/catalog.jsonl"
  API_ID="$(docker compose -f "$REPO_DIR/docker-compose.yml" ps -q api)"
  docker cp "$TMP/catalog.jsonl" "$API_ID:/tmp/catalog.jsonl"
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T api python - /tmp/catalog.jsonl \
    < "$REPO_DIR/scripts/catalog_load.py"
  echo "NOTE: if parts_new above is large, regen frontend/seo-manifest.json"
  echo "      (node frontend/scripts/gen-seo-manifest.mjs) before the next deploy."
fi

echo "done."
