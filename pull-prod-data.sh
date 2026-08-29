#!/usr/bin/env bash
# Pull production data into the LOCAL dev DB. Two modes, both safe/idempotent:
#
#   ./pull-prod-data.sh              # reporting + catalog (NOT users)
#   ./pull-prod-data.sh --reporting  # page_views + messages (replace local copies)
#   ./pull-prod-data.sh --catalog    # suppliers/parts/listings/breaks by natural
#                                    # keys (additive upsert — local-only rows
#                                    # survive; prod is NEVER written)
#   ./pull-prod-data.sh --users      # REGISTERED CUSTOMERS only, upserted by
#                                    # email (additive; staff rows untouched)
#
# Reporting = the standing post-deploy rule (analytics/messages are prod-truth).
# Catalog   = after import runs on prod, so local mirrors the live inventory.
# Users     = see who has registered. Deliberately NOT in the default run: it
#             carries real people's addresses and password hashes onto a dev
#             machine, so it is opt-in per invocation.
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

case "$MODE" in
  --all|--reporting|--catalog|--users) ;;
  *) echo "usage: $(basename "$0") [--reporting|--catalog|--users]" >&2; exit 2 ;;
esac

if [[ "$MODE" == "--all" || "$MODE" == "--reporting" ]]; then
  echo "==> reporting pull (page_views + messages)"
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T db \
    pg_dump -U circuits -d circuits --data-only -t page_views -t messages" \
    > "$TMP/reporting.sql"
  # messages.user_id -> users(id) (migration 043) makes this restore fail: the
  # prod user rows it points at are not local rows, so the first message that
  # carries one violates the FK, the whole COPY aborts, and psql — which exits
  # 0 unless you ask for ON_ERROR_STOP — hands back success while the local
  # table sits EMPTY from the TRUNCATE. So: one transaction; drop the FK for
  # the load; NULL the ids that do not resolve locally (a NULL user_id means
  # "the shared staff inbox", the honest fallback for a submission whose
  # account is not here); re-add the constraint, which re-validates every
  # restored row. Any failure now rolls the whole thing back — the local copy
  # you had is still the local copy you have — and the pipeline's non-zero
  # exit trips set -e instead of passing silently.
  {
    echo "BEGIN;"
    echo "TRUNCATE page_views, messages;"
    echo "ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS fk_messages_user_id;"
    cat "$TMP/reporting.sql"
    # pg_dump sets search_path to '' — everything after it stays qualified.
    echo "SET search_path = public;"
    echo "UPDATE public.messages m SET user_id = NULL WHERE m.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = m.user_id);"
    echo "ALTER TABLE public.messages ADD CONSTRAINT fk_messages_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;"
    echo "COMMIT;"
  } | docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
        psql -U circuits -d circuits -v ON_ERROR_STOP=1 > /dev/null
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits -c \
    "SELECT count(*) AS page_views FROM page_views; SELECT count(*) AS messages FROM messages; SELECT count(*) AS messages_unlinked_from_a_local_user FROM messages WHERE user_id IS NULL;"
fi

if [[ "$MODE" == "--all" || "$MODE" == "--catalog" ]]; then
  echo "==> catalog pull (suppliers/parts/listings/price breaks, natural keys)"
  push_key
  # gzip on the prod side: the JSONL compresses ~8x (280MB -> 35MB measured
  # 2026-08-28), and the wire is the slow leg of a pull.
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T api python - | gzip -c" \
    < "$REPO_DIR/scripts/catalog_export.py" > "$TMP/catalog.jsonl.gz"
  gunzip -f "$TMP/catalog.jsonl.gz"
  API_ID="$(docker compose -f "$REPO_DIR/docker-compose.yml" ps -q api)"
  docker cp "$TMP/catalog.jsonl" "$API_ID:/tmp/catalog.jsonl"
  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T api python - /tmp/catalog.jsonl \
    < "$REPO_DIR/scripts/catalog_load.py"
  echo "NOTE: if parts_new above is large, regen frontend/seo-manifest.json"
  echo "      (node frontend/scripts/gen-seo-manifest.mjs) before the next deploy."
fi

if [[ "$MODE" == "--users" ]]; then
  echo "==> users pull (registered customers only, upsert by email)"
  # CUSTOMERS ONLY, and additive. Three reasons this is not a `users` table copy:
  #
  #   * Local staff rows are NOT prod staff rows. seed.py gives them local
  #     passwords on purpose (CLAUDE.md: "LOCAL admin passwords are NOT
  #     production passwords"), so overwriting them with prod's bcrypt hashes
  #     would lock you out of your own dev console.
  #   * Local `messages.user_id`, `calendar_events.created_by_id` and
  #     `bom_shares.user_id` point at LOCAL user uuids. Replacing the rows
  #     re-mints those ids and orphans every one of them.
  #   * supplier_id / manufacturer_id are per-environment surrogates — the
  #     catalog transfer pair is natural-key based precisely because local and
  #     prod ids differ — so the links travel BY NAME and are re-resolved here.
  #
  # Matched on lower(email), which is the same expression `uq_users_email_lower`
  # covers, so at most one local row can ever match. An existing local row keeps
  # its uuid, which is what lets local messages stay attached to it.
  # The query travels as a FILE on stdin, not inlined in the ssh command:
  # nesting quotes through ssh -> sh -> docker exec -> psql mangles the parens
  # in `COPY ( ... )`, which is how the first attempt at this failed. The
  # catalog mode pipes a script the same way.
  cat > "$TMP/users_query.sql" <<'SQL'
COPY (
  SELECT u.username, u.email, u.password_hash, u.first_name, u.last_name,
         u.email_verified_at, u.activated_at, u.signup_ip, u.signup_country,
         u.must_change_password, u.password_changed_at, u.created_at, u.updated_at,
         s.name, m.name
  FROM users u
  LEFT JOIN suppliers s ON s.id = u.supplier_id
  LEFT JOIN manufacturers m ON m.id = u.manufacturer_id
  WHERE u.role = 'user'
  ORDER BY u.created_at
) TO STDOUT
SQL
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T db \
    psql -U circuits -d circuits -q -v ON_ERROR_STOP=1 -f -" \
    < "$TMP/users_query.sql" > "$TMP/users.tsv"
  echo "    $(wc -l < "$TMP/users.tsv") customer row(s) on prod"

  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE users_in (username text, email text, password_hash text,"
    echo "  first_name text, last_name text, email_verified_at timestamptz,"
    echo "  activated_at timestamptz, signup_ip text, signup_country text,"
    echo "  must_change_password boolean, password_changed_at timestamptz,"
    echo "  created_at timestamptz, updated_at timestamptz,"
    echo "  supplier_name text, manufacturer_name text);"
    echo "COPY users_in FROM STDIN;"
    cat "$TMP/users.tsv"
    printf '%s\n' '\.'
    echo "SET search_path = public;"
    # role = 'user' on BOTH sides. Without it, a prod customer who registered
    # with a staff address would overwrite that staff row's password hash.
    echo "UPDATE users u SET username = i.username, password_hash = i.password_hash,"
    echo "  first_name = i.first_name, last_name = i.last_name,"
    echo "  email_verified_at = i.email_verified_at, activated_at = i.activated_at,"
    echo "  signup_ip = i.signup_ip, signup_country = i.signup_country,"
    echo "  must_change_password = i.must_change_password,"
    echo "  password_changed_at = i.password_changed_at, updated_at = i.updated_at"
    echo "  FROM users_in i WHERE lower(u.email) = lower(i.email) AND u.role = 'user';"
    # NOT EXISTS over EVERY role, so a colliding staff address is skipped rather
    # than duplicated — uq_users_email_lower would reject it anyway, and a
    # rolled-back pull is worse than a reported skip.
    echo "INSERT INTO users (id, username, email, password_hash, role, first_name, last_name,"
    echo "  email_verified_at, activated_at, signup_ip, signup_country,"
    echo "  must_change_password, password_changed_at, created_at, updated_at)"
    echo "  SELECT gen_random_uuid(), i.username, i.email, i.password_hash, 'user',"
    echo "         i.first_name, i.last_name, i.email_verified_at, i.activated_at,"
    echo "         i.signup_ip, i.signup_country, i.must_change_password,"
    echo "         i.password_changed_at, i.created_at, i.updated_at"
    echo "  FROM users_in i"
    echo "  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email));"
    # Links by NAME. A supplier that is not local yet leaves the link NULL,
    # which reads as "free tier" — honest, and it self-heals on the next
    # --catalog pull followed by another --users.
    echo "UPDATE users u SET supplier_id = s.id FROM users_in i"
    echo "  JOIN suppliers s ON s.name = i.supplier_name"
    echo "  WHERE lower(u.email) = lower(i.email) AND u.role = 'user';"
    echo "UPDATE users u SET manufacturer_id = m.id FROM users_in i"
    echo "  JOIN manufacturers m ON m.name = i.manufacturer_name"
    echo "  WHERE lower(u.email) = lower(i.email) AND u.role = 'user';"
    echo "COMMIT;"
  } | docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
        psql -U circuits -d circuits -v ON_ERROR_STOP=1 > /dev/null

  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits -c \
    "SELECT count(*) AS customers_local FROM users WHERE role = 'user'; \
     SELECT count(*) AS awaiting_activation FROM users WHERE role = 'user' AND activated_at IS NULL; \
     SELECT count(*) AS unlinked_to_a_local_company FROM users WHERE role = 'user' AND supplier_id IS NULL AND manufacturer_id IS NULL;"
fi

echo "done."
