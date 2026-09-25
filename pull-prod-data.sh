#!/usr/bin/env bash
# Pull production data into the LOCAL dev DB. Two modes, both safe/idempotent:
#
#   ./pull-prod-data.sh              # reporting + catalog (NOT users)
#   ./pull-prod-data.sh --reporting  # page_views + messages (replace local copies)
#   ./pull-prod-data.sh --catalog    # suppliers/parts/listings/breaks by natural
#                                    # keys (additive upsert — local-only rows
#                                    # survive; prod is NEVER written)
#   ./pull-prod-data.sh --users      # REGISTERED CUSTOMERS (upserted by email) + the
#                                   #   leads reps added and every call outcome (by source_key)
#                                   # customers are upserted by
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

  # ── The leads reps added, and every call outcome (owner ask, 2026-09-25) ──
  # Rides with --users because it is the same kind of thing: per-environment
  # STATE that no seed can recreate. Per-environment surrogates never travel:
  # manufacturer_id rides by NAME and is relinked here (seed step 5 does the
  # same on the next api start); a CUSTOMER's private prospects (user_id IS
  # NOT NULL) stay home, since they point at a prod account uuid that means
  # nothing here. Roster rows exist on both sides under the same source_key
  # (seed_leads keys them identically), so they UPDATE — outcomes, notes,
  # enrichment edits, photos — and console adds INSERT. lead_contacts keep
  # their uuids (uuid4 is unique across environments), so a second pull adds
  # nothing twice. Like the rest of this mode: additive, one transaction,
  # ON_ERROR_STOP, never a TRUNCATE.
  echo "==> leads pull (the roster's CRM state + every lead a rep added + their outcomes, upsert by source_key)"
  cat > "$TMP/leads_query.sql" <<'SQL'
COPY (
  SELECT l.source_key, m.name, l.company_name, l.branch_label, l.company_slug, l.tier, l.ring, l.street, l.city, l.state, l.postal_code, l.main_phone, l.website, l.sales_email, l.contact_name, l.needs_enrichment, l.contact_title, l.direct_phone, l.contact_email, l.linkedin_url, l.hours_tz, l.notes, l.last_outcome, l.last_contacted_at, l.contact_attempts, l.created_at, l.updated_at, l.distance_miles, l.created_by, l.photo_url
  FROM leads l LEFT JOIN manufacturers m ON m.id = l.manufacturer_id
  WHERE l.user_id IS NULL
  ORDER BY l.created_at
) TO STDOUT
SQL
  cat > "$TMP/contacts_query.sql" <<'SQL'
COPY (
  SELECT c.id, l.source_key, c.outcome, c.sale_tier, c.note, c.recorded_by, c.created_at
  FROM lead_contacts c JOIN leads l ON l.id = c.lead_id
  WHERE l.user_id IS NULL
  ORDER BY c.created_at
) TO STDOUT
SQL
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T db \
    psql -U circuits -d circuits -q -v ON_ERROR_STOP=1 -f -" \
    < "$TMP/leads_query.sql" > "$TMP/leads.tsv"
  push_key
  "${SSH[@]}" "cd /opt/circuits-com && sudo docker compose exec -T db \
    psql -U circuits -d circuits -q -v ON_ERROR_STOP=1 -f -" \
    < "$TMP/contacts_query.sql" > "$TMP/contacts.tsv"
  echo "    $(wc -l < "$TMP/leads.tsv") lead row(s) and $(wc -l < "$TMP/contacts.tsv") outcome row(s) on prod"

  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE leads_in (source_key text, manufacturer_name text, company_name text, branch_label text, company_slug text, tier text, ring text, street text, city text, state text, postal_code text, main_phone text, website text, sales_email text, contact_name text, needs_enrichment boolean, contact_title text, direct_phone text, contact_email text, linkedin_url text, hours_tz text, notes text, last_outcome text, last_contacted_at timestamptz, contact_attempts integer, created_at timestamptz, updated_at timestamptz, distance_miles numeric, created_by text, photo_url text);"
    echo "COPY leads_in FROM STDIN;"
    cat "$TMP/leads.tsv"
    printf '%s\n' '\.'
    echo "CREATE TEMP TABLE contacts_in (id uuid, source_key text, outcome text, sale_tier text, note text, recorded_by text, created_at timestamptz);"
    echo "COPY contacts_in FROM STDIN;"
    cat "$TMP/contacts.tsv"
    printf '%s\n' '\.'
    echo "SET search_path = public;"
    # Only the staff roster (user_id IS NULL) on the local side too — a local
    # customer prospect that happens to share a source_key is not this row.
    echo "UPDATE leads l SET company_name = i.company_name, branch_label = i.branch_label, company_slug = i.company_slug, tier = i.tier, ring = i.ring, street = i.street, city = i.city, state = i.state, postal_code = i.postal_code, main_phone = i.main_phone, website = i.website, sales_email = i.sales_email, contact_name = i.contact_name, needs_enrichment = i.needs_enrichment, contact_title = i.contact_title, direct_phone = i.direct_phone, contact_email = i.contact_email, linkedin_url = i.linkedin_url, hours_tz = i.hours_tz, notes = i.notes, last_outcome = i.last_outcome, last_contacted_at = i.last_contacted_at, contact_attempts = i.contact_attempts, updated_at = i.updated_at, distance_miles = i.distance_miles, created_by = i.created_by, photo_url = i.photo_url"
    echo "  FROM leads_in i WHERE l.source_key = i.source_key AND l.user_id IS NULL;"
    echo "INSERT INTO leads (id, source_key, company_name, branch_label, company_slug, tier, ring, street, city, state, postal_code, main_phone, website, sales_email, contact_name, needs_enrichment, contact_title, direct_phone, contact_email, linkedin_url, hours_tz, notes, last_outcome, last_contacted_at, contact_attempts, created_at, updated_at, distance_miles, created_by, photo_url)"
    echo "  SELECT gen_random_uuid(), i.source_key, i.company_name, i.branch_label, i.company_slug, i.tier, i.ring, i.street, i.city, i.state, i.postal_code, i.main_phone, i.website, i.sales_email, i.contact_name, i.needs_enrichment, i.contact_title, i.direct_phone, i.contact_email, i.linkedin_url, i.hours_tz, i.notes, i.last_outcome, i.last_contacted_at, i.contact_attempts, i.created_at, i.updated_at, i.distance_miles, i.created_by, i.photo_url"
    echo "  FROM leads_in i"
    echo "  WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.source_key = i.source_key);"
    echo "UPDATE leads l SET manufacturer_id = m.id FROM leads_in i"
    echo "  JOIN manufacturers m ON m.name = i.manufacturer_name"
    echo "  WHERE l.source_key = i.source_key AND l.user_id IS NULL;"
    echo "INSERT INTO lead_contacts (id, lead_id, outcome, sale_tier, note, recorded_by, created_at)"
    echo "  SELECT i.id, l.id, i.outcome, i.sale_tier, i.note, i.recorded_by, i.created_at"
    echo "  FROM contacts_in i JOIN leads l ON l.source_key = i.source_key AND l.user_id IS NULL"
    echo "  WHERE NOT EXISTS (SELECT 1 FROM lead_contacts c WHERE c.id = i.id);"
    echo "COMMIT;"
  } | docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
        psql -U circuits -d circuits -v ON_ERROR_STOP=1 > /dev/null

  docker compose -f "$REPO_DIR/docker-compose.yml" exec -T db \
    psql -U circuits -d circuits -c \
    "SELECT count(*) AS leads_local FROM leads WHERE user_id IS NULL; \
     SELECT count(*) AS added_by_reps FROM leads WHERE user_id IS NULL AND created_by IS NOT NULL; \
     SELECT count(*) AS outcomes_local FROM lead_contacts; \
     SELECT count(*) AS leads_with_an_outcome FROM leads WHERE user_id IS NULL AND last_outcome IS NOT NULL;"
fi

echo "done."
