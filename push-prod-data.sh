#!/usr/bin/env bash
# Push the LOCAL catalog to PRODUCTION — the mirror of pull-prod-data.sh's
# --catalog mode, riding the same natural-key transfer pair
# (scripts/catalog_export.py → scripts/catalog_load.py).
#
#   ./push-prod-data.sh        # export local catalog → load into prod (asks first)
#
# SAFETY:
#   - Additive/upsert ONLY: the loader never deletes rows the export doesn't
#     mention, so prod-only rows (sponsors, users, page_views, newer imports…)
#     are untouched. Re-running converges; interrupting loses nothing
#     (per-500 commits).
#   - Catalog tables only (suppliers/parts/listings/price breaks). Reporting
#     data (page_views, messages) is prod-truth and moves in ONE direction —
#     pull. There is deliberately no reporting mode here.
#   - The loader is piped from THIS checkout's scripts/, so the local version
#     runs on prod even before the commit carrying it is deployed there.
#
# Requires: AWS CLI (Instance Connect), ~/.ssh/id_ed25519, local stack running.
set -euo pipefail

INSTANCE_ID="i-0d456bd12719e2176"
EIP="100.55.235.167"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

push_key() {
  # Instance Connect keys live 60s — push right before each ssh/scp use.
  aws ec2-instance-connect send-ssh-public-key --instance-id "$INSTANCE_ID" \
    --instance-os-user ec2-user \
    --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" --output text > /dev/null
}
SSH=(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "ec2-user@$EIP")

echo "==> exporting the LOCAL catalog (suppliers/parts/listings/price breaks, natural keys)"
docker compose -f "$REPO_DIR/docker-compose.yml" exec -T api python - \
  < "$REPO_DIR/scripts/catalog_export.py" > "$TMP/catalog.jsonl"
RECORDS="$(wc -l < "$TMP/catalog.jsonl")"
SIZE="$(du -h "$TMP/catalog.jsonl" | cut -f1)"
echo "exported $RECORDS records ($SIZE)"

printf '\033[0;33m%s\033[0m\n' \
  "This LOADS the export into the PRODUCTION database (additive upsert — nothing is ever deleted)."
read -p "Continue? (y/N) " -n 1 -r; echo
[[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted — prod untouched."; exit 0; }

echo "==> copying $SIZE to prod (this can take a minute)"
push_key
scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
  "$TMP/catalog.jsonl" "ec2-user@$EIP:/tmp/catalog-push.jsonl"
push_key
"${SSH[@]}" "sudo docker cp /tmp/catalog-push.jsonl circuits-com-api-1:/tmp/catalog-push.jsonl && rm /tmp/catalog-push.jsonl"

echo "==> loading on prod (per-500 commits; progress lines below)"
push_key
"${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T api python - /tmp/catalog-push.jsonl" \
  < "$REPO_DIR/scripts/catalog_load.py"

echo
echo "NOTE: if parts_new above is large, regen frontend/seo-manifest.json"
echo "      (node frontend/scripts/gen-seo-manifest.mjs) and deploy --frontend,"
echo "      or the new part pages serve the generic shell."
echo "NOTE: pushed parts get their manufacturer links on prod's next api start"
echo "      (any deploy) — seed step 5 relinks by name wherever the link is NULL."
echo "done."
