#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# circuitcenter.ai — Deploy Script
# ============================================================================
# Usage:
#   ./deploy.sh              Deploy latest committed changes (frontend + API)
#   ./deploy.sh --frontend   Deploy frontend only (faster)
#   ./deploy.sh --reseed     Deploy all + clear & reseed database
#   ./deploy.sh pull         Mirror the PRODUCTION database into your LOCAL one
#                            (backs up local first, then overwrites it)
#   ./deploy.sh --status     Check container status on EC2
#   ./deploy.sh --logs       Tail logs from all containers
#   ./deploy.sh --cert-renew Renew Let's Encrypt SSL certificate
#
# Tip: add  alias circuitcenter='/home/matthew/circuits-com/deploy.sh'  to your
#      shell rc, then run:  circuitcenter pull  ·  circuitcenter --frontend  · ...
#
# Prerequisites:
#   - AWS CLI configured (aws sts get-caller-identity works)
#   - VPN connected (WireGuard to 3.225.10.152)
#   - SSH key at ~/.ssh/id_ed25519
#   - Changes committed and pushed to origin/master
# ============================================================================

EC2_INSTANCE_ID="i-0d456bd12719e2176"
EC2_IP="100.55.235.167"
EC2_USER="ec2-user"
SSH_KEY="$HOME/.ssh/id_ed25519.pub"
APP_DIR="/opt/circuits-com"
COMPOSE_CMD="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# ─── Helpers ─────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

push_ssh_key() {
    # Progress goes to stderr so run_remote's stdout stays clean for binary
    # captures (e.g. `run_remote "pg_dump -Fc" > file` in db_pull).
    echo "Pushing temporary SSH key via EC2 Instance Connect..." >&2
    aws ec2-instance-connect send-ssh-public-key \
        --instance-id "$EC2_INSTANCE_ID" \
        --instance-os-user "$EC2_USER" \
        --ssh-public-key "file://$SSH_KEY" \
        --output text > /dev/null 2>&1
}

run_remote() {
    push_ssh_key
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$EC2_USER@$EC2_IP" "$@"
}

check_prerequisites() {
    # Check AWS CLI
    if ! aws sts get-caller-identity > /dev/null 2>&1; then
        red "ERROR: AWS CLI not configured. Run 'aws configure' first."
        exit 1
    fi

    # Check SSH key
    if [[ ! -f "$SSH_KEY" ]]; then
        red "ERROR: SSH key not found at $SSH_KEY"
        exit 1
    fi

    # Check git is clean
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        yellow "WARNING: You have uncommitted changes. Commit and push first."
        git status --short
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        [[ $REPLY =~ ^[Yy]$ ]] || exit 1
    fi

    # Check pushed
    local_head=$(git rev-parse HEAD)
    remote_head=$(git rev-parse origin/master 2>/dev/null || echo "unknown")
    if [[ "$local_head" != "$remote_head" ]]; then
        yellow "WARNING: Local HEAD differs from origin/master. Push first?"
        read -p "Push now? (Y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            git push origin master
            green "Pushed to origin/master."
        fi
    fi
}

# ─── Commands ────────────────────────────────────────────────────────────────

deploy_all() {
    echo "Deploying all services..."
    # `up -d` recreates api + frontend, but nginx is unaffected and keeps
    # its cached upstream DNS pointing at the OLD frontend container's IP
    # → 502 on `/` until nginx is restarted. Folding the restart in here
    # eliminates the `--frontend` chase that used to be required (which
    # also incurred a wasteful second frontend build).
    # DOCKER_BUILDKIT=1 enables BuildKit cache mounts in the Dockerfiles
    # (~5-10× speedup on dep-install when package-lock/pyproject hasn't
    # changed). Docker 23+ defaults to BuildKit; the export is belt+braces.
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && DOCKER_BUILDKIT=1 $COMPOSE_CMD build api calendar-reminders cost-sync feed-import && $COMPOSE_CMD up -d && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    green "All services rebuilt, nginx restarted."
}

deploy_frontend() {
    echo "Deploying frontend only..."
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && $COMPOSE_CMD up -d frontend && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    green "Frontend rebuilt, nginx restarted."
}

# Refuse to destroy a catalog nobody can rebuild without the operator saying so
# in as many words. This function exists because the hazard below was once
# documented in a comment ("~171k on prod — think hard before running this
# there") and nothing enforced it: a single flag, no questions asked, and
# 198,577 feed-imported parts were gone. A comment the operator reads afterwards
# is not a guard.
#
# The count is measured on the LIVE database, not guessed, and the operator has
# to type it back. That is deliberate: a y/N prompt is muscle memory, whereas
# typing the number requires reading the number.
confirm_reseed() {
    local live_parts seeded_parts doomed
    echo ""
    yellow "──────────────────────────────────────────────────────────────"
    yellow "  ./deploy.sh --reseed TRUNCATEs the catalog on PRODUCTION."
    yellow "──────────────────────────────────────────────────────────────"
    echo "Measuring what this would destroy..."

    live_parts=$(run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM parts;'" 2>/dev/null | tr -d '[:space:]')
    if ! [[ "$live_parts" =~ ^[0-9]+$ ]]; then
        red "Could not count parts on prod — refusing to reseed blind."
        exit 1
    fi
    # What the seed can put back: the committed catalog JSON, nothing else.
    # The catalog files are {subcategory-slug: [part, ...]} — count the leaves,
    # deduped on sku, because the same chip is listed under several categories
    # and _seed_real_catalog creates it once (its probe is upper()-keyed).
    seeded_parts=$(python3 - <<'PYCOUNT'
import json, pathlib
skus = set()
for f in sorted(pathlib.Path("api/app/db/catalog_data").glob("*.json")):
    try:
        data = json.loads(f.read_text())
    except Exception:
        continue
    buckets = data.values() if isinstance(data, dict) else [data]
    for rows in buckets:
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("sku"):
                skus.add(str(row["sku"]).upper())
print(len(skus))
PYCOUNT
)
    doomed=$(( live_parts - seeded_parts ))
    (( doomed < 0 )) && doomed=0

    echo ""
    echo "  parts on prod now .................. $live_parts"
    echo "  parts the seed can recreate ........ $seeded_parts  (catalog JSON)"
    red   "  parts that would be DESTROYED ...... $doomed"
    echo ""
    echo "  Also destroyed: activity_events, and any admin-UI row seed.py does"
    echo "  not create. Carried across by hand: users, calendar, messages,"
    echo "  BOM shares, feed config. A full -Fc dump is written first as the"
    echo "  undo, but restoring it is a manual job."
    echo ""

    if (( doomed == 0 )); then
        echo "Nothing unrecoverable at risk. Continuing."
        return 0
    fi

    yellow "To proceed, type the number of parts you are destroying ($doomed):"
    printf "> "
    local typed
    read -r typed
    if [[ "$typed" != "$doomed" ]]; then
        echo ""
        green "Reseed cancelled. Nothing was touched."
        exit 0
    fi
    echo ""
    yellow "Proceeding. The undo is /tmp/pre-reseed-safety.dump on the box —"
    yellow "copy it somewhere off the instance before the next reseed overwrites it."
    echo ""
}

deploy_reseed() {
    confirm_reseed
    echo "Deploying all services + clearing and reseeding database..."
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && DOCKER_BUILDKIT=1 $COMPOSE_CMD build api calendar-reminders cost-sync feed-import && $COMPOSE_CMD up -d && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    # Five things are carried across the TRUNCATE by hand: users, the calendar,
    # the message inbox, shared BOM links, and the per-supplier feed config.
    #
    # TRUNCATE ... CASCADE is TABLE-level and TRANSITIVE — it follows every
    # REFERENCING foreign key and ignores ON DELETE semantics entirely. (ON
    # DELETE governs what happens when the referenced ROW is later deleted; it
    # neither exempts a table from TRUNCATE nor rescues an INSERT that names a
    # row which no longer exists. A comment here once claimed created_by_id's
    # ON DELETE SET NULL made the calendar restore "a straight load" — measured
    # on the real schema, that load died on calendar_events_created_by_id_fkey
    # with psql exit 3 and restored ZERO events, because the seed re-mints
    # every user uuid.) The chain:
    #   suppliers -> users (users.supplier_id)
    #             -> calendar_events (created_by_id) -> calendar_reminder_sends
    #             -> messages   (messages.user_id, migration 043)
    #             -> bom_shares (bom_shares.user_id)
    #   suppliers -> supplier_feeds (supplier_id IS its primary key)
    #
    # ORDER is the design, and users is the keystone:
    #   1. dump everything BEFORE the TRUNCATE — plus one full -Fc dump of the
    #      whole DB, the one-deploy-cycle undo for everything else;
    #   2. restore users BETWEEN the TRUNCATE and the seed. seed.py's
    #      _seed_admin_user keys on username, so it ADOPTS the restored staff
    #      rows (uuids, bcrypt hashes, roles intact) instead of colliding with
    #      them — and CUSTOMER accounts, which the seed NEVER recreates, come
    #      back whole. users.supplier_id is NULLed under the dropped FK
    #      (suppliers is empty at that instant) and relinked BY NAME after the
    #      seed; users.manufacturer_id needs nothing (manufacturers is outside
    #      the truncate graph).
    #   3. seed;
    #   4. the rest AFTER the seed. Users kept their uuids, so calendar
    #      attribution and message/BOM ownership genuinely survive; the
    #      NULL-where-unresolvable guards below are a safety net for rows
    #      minted in the seconds between the dumps, not the mechanism.
    #   5. supplier_feeds cannot ride pg_dump at all (its PK is the supplier
    #      uuid, and every supplier uuid changes), so it travels as a
    #      (supplier NAME, config) TSV re-keyed onto the reseeded suppliers.
    #      Without this every "Nightly auto-import" toggle silently turned OFF
    #      and every import cursor died on a reseed. Rows whose supplier the
    #      seed no longer creates are dropped — the supplier itself is gone.
    #
    # STILL DESTROYED, deliberately (test_leads_schema.py's census is the
    # ledger): activity_events (operational history whose supplier subjects are
    # re-minted anyway), every feed-imported part the catalog JSON never
    # carried (~171k on prod — think hard before running this there), and
    # admin-UI rows outside seed.py. All of it recoverable from the -Fc dump
    # until the next reseed overwrites it.
    #
    # Adding a table that FKs into suppliers/users/categories joins it to this
    # cascade. api/tests/test_leads_schema.py fails until it is declared:
    # reseeded from source, carried here, or a named accepted loss.
    local usr_pre usr_post lnk_pre lnk_post cal_pre cal_post msg_pre msg_post bom_pre bom_post feeds_pre feeds_post
    usr_pre="BEGIN; ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_supplier_id_fkey;"
    usr_post="SET search_path = public; UPDATE public.users u SET supplier_id = NULL WHERE u.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = u.supplier_id); ALTER TABLE public.users ADD CONSTRAINT users_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id); COMMIT;"
    lnk_pre="BEGIN; CREATE TEMP TABLE user_supplier_links (user_id uuid, supplier_name text); COPY user_supplier_links (user_id, supplier_name) FROM STDIN;"
    lnk_post="UPDATE public.users u SET supplier_id = s.id FROM user_supplier_links l JOIN public.suppliers s ON s.name = l.supplier_name WHERE u.id = l.user_id; COMMIT;"
    cal_pre="BEGIN; ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_created_by_id_fkey;"
    cal_post="SET search_path = public; UPDATE public.calendar_events e SET created_by_id = NULL WHERE e.created_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = e.created_by_id); ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL; COMMIT;"
    msg_pre="BEGIN; ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS fk_messages_user_id;"
    msg_post="SET search_path = public; UPDATE public.messages m SET user_id = NULL WHERE m.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = m.user_id); ALTER TABLE public.messages ADD CONSTRAINT fk_messages_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE; COMMIT;"
    bom_pre="BEGIN; ALTER TABLE public.bom_shares DROP CONSTRAINT IF EXISTS bom_shares_user_id_fkey;"
    bom_post="SET search_path = public; UPDATE public.bom_shares b SET user_id = NULL WHERE b.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = b.user_id); ALTER TABLE public.bom_shares ADD CONSTRAINT bom_shares_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL; COMMIT;"
    feeds_pre="BEGIN; CREATE TEMP TABLE feeds_restore (supplier_name text, feed_url text, api_key text, auto_import_enabled boolean, last_synced_at timestamptz, import_cursor text); COPY feeds_restore (supplier_name, feed_url, api_key, auto_import_enabled, last_synced_at, import_cursor) FROM STDIN;"
    feeds_post="INSERT INTO public.supplier_feeds (supplier_id, feed_url, api_key, auto_import_enabled, last_synced_at, import_cursor) SELECT s.id, r.feed_url, r.api_key, r.auto_import_enabled, r.last_synced_at, r.import_cursor::json FROM feeds_restore r JOIN public.suppliers s ON s.name = r.supplier_name ON CONFLICT (supplier_id) DO NOTHING; COMMIT;"
    echo "Safety dump of the whole database (undo for everything, until the next reseed overwrites it)..."
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits -Fc > /tmp/pre-reseed-safety.dump && ls -la /tmp/pre-reseed-safety.dump"
    echo "Backing up what the TRUNCATE reaches (users, calendar, messages, BOM shares, feed config)..."
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits --data-only --table=users > /tmp/users-backup.sql && wc -l < /tmp/users-backup.sql"
    run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -c \"COPY (SELECT u.id, s.name FROM users u JOIN suppliers s ON s.id = u.supplier_id) TO STDOUT\" > /tmp/user-supplier-links.tsv && wc -l < /tmp/user-supplier-links.tsv"
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits --data-only --table=calendar_events --table=calendar_reminder_sends > /tmp/calendar-backup.sql && wc -l < /tmp/calendar-backup.sql"
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits --data-only --table=messages > /tmp/messages-backup.sql && wc -l < /tmp/messages-backup.sql"
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits --data-only --table=bom_shares > /tmp/bom-shares-backup.sql && wc -l < /tmp/bom-shares-backup.sql"
    run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -c \"COPY (SELECT s.name, f.feed_url, f.api_key, f.auto_import_enabled, f.last_synced_at, f.import_cursor FROM supplier_feeds f JOIN suppliers s ON s.id = f.supplier_id) TO STDOUT\" > /tmp/feeds-backup.tsv && wc -l < /tmp/feeds-backup.tsv"
    echo "Clearing database..."
    run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -c 'TRUNCATE sponsors, category_suppliers, categories, suppliers CASCADE;'"
    echo "Restoring users BEFORE the seed (the seed adopts them; every later restore's ids then resolve)..."
    run_remote "{ echo \"$usr_pre\"; cat /tmp/users-backup.sql; echo \"$usr_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM users;'"
    echo "Reseeding..."
    run_remote "sudo docker exec circuits-com-api-1 python -m app.db.seed"
    echo "Relinking users to their reseeded suppliers by name..."
    run_remote "{ echo \"$lnk_pre\"; cat /tmp/user-supplier-links.tsv; printf '%s\n' '\\.'; echo \"$lnk_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1"
    echo "Restoring the calendar..."
    run_remote "{ echo \"$cal_pre\"; cat /tmp/calendar-backup.sql; echo \"$cal_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM calendar_events;'"
    echo "Restoring the message inbox..."
    run_remote "{ echo \"$msg_pre\"; cat /tmp/messages-backup.sql; echo \"$msg_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM messages;'"
    echo "Restoring shared BOM links..."
    run_remote "{ echo \"$bom_pre\"; cat /tmp/bom-shares-backup.sql; echo \"$bom_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM bom_shares;'"
    echo "Restoring per-supplier feed config (re-keyed by supplier name)..."
    run_remote "{ echo \"$feeds_pre\"; cat /tmp/feeds-backup.tsv; printf '%s\n' '\\.'; echo \"$feeds_post\"; } | sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM supplier_feeds;'"
    green "All services rebuilt, nginx restarted. Database cleared and reseeded; users, calendar, messages, BOM shares and feed config carried across."
}


show_status() {
    echo "Container status:"
    run_remote "sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
}

show_logs() {
    echo "Tailing logs (Ctrl+C to stop)..."
    run_remote "cd $APP_DIR && $COMPOSE_CMD logs --tail=50 -f"
}

renew_cert() {
    echo "Renewing Let's Encrypt certificate..."
    run_remote "cd $APP_DIR && $COMPOSE_CMD stop nginx && sudo certbot renew --standalone && $COMPOSE_CMD start nginx"
    green "Certificate renewed, nginx restarted."
}

# Mirror the production database into the local one. Backs up local first,
# then drop/recreates the local `circuits` DB and restores the prod dump into
# it — an exact snapshot, so local bug-fixing runs against real site data.
db_pull() {
    local ts backup_dir dump
    local local_db="circuits-com-db-1" local_api="circuits-com-api-1"
    ts=$(date +%Y%m%d-%H%M%S)
    backup_dir="$HOME/circuits-prod-backups/db-pull-$ts"
    dump="$backup_dir/prod.dump"

    if ! docker ps --format '{{.Names}}' | grep -qx "$local_db"; then
        red "ERROR: local DB container '$local_db' isn't running. Start the stack first (docker compose up -d)."
        exit 1
    fi

    yellow "This OVERWRITES your local database with production data (local is backed up first)."
    read -p "Continue? (y/N) " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted — local DB untouched."; exit 0; }

    mkdir -p "$backup_dir"

    echo "[1/5] Backing up local DB → $backup_dir/local-pre-pull.dump"
    docker exec "$local_db" pg_dump -U circuits -Fc circuits > "$backup_dir/local-pre-pull.dump"

    echo "[2/5] Dumping production DB → $dump"
    run_remote "sudo docker exec $local_db pg_dump -U circuits -Fc circuits" > "$dump"
    if ! docker exec -i "$local_db" pg_restore -l < "$dump" > /dev/null 2>&1; then
        red "ERROR: the production dump is not a valid archive — aborting (local DB untouched)."
        exit 1
    fi

    echo "[3/5] Resetting local database (stop api, terminate connections, drop/recreate)"
    docker stop "$local_api" > /dev/null 2>&1 || true
    docker exec "$local_db" psql -U circuits -d postgres -c \
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='circuits' AND pid <> pg_backend_pid();" > /dev/null
    docker exec "$local_db" psql -U circuits -d postgres -c "DROP DATABASE IF EXISTS circuits;" > /dev/null
    docker exec "$local_db" psql -U circuits -d postgres -c "CREATE DATABASE circuits OWNER circuits;" > /dev/null

    echo "[4/5] Restoring production data into local"
    docker exec -i "$local_db" pg_restore -U circuits -d circuits --no-owner --no-privileges < "$dump"

    echo "[5/5] Restarting local api"
    docker start "$local_api" > /dev/null 2>&1 || true

    green "Local DB now mirrors production."
    echo "Backup + prod dump saved in: $backup_dir"
    docker exec "$local_db" psql -U circuits circuits -t -c \
        "SELECT 'users='||count(*) FROM users UNION ALL SELECT 'suppliers='||count(*) FROM suppliers UNION ALL SELECT 'sponsors='||count(*) FROM sponsors UNION ALL SELECT 'parts='||count(*) FROM parts UNION ALL SELECT 'messages='||count(*) FROM messages UNION ALL SELECT 'page_views='||count(*) FROM page_views;" 2>/dev/null | grep -E '=[0-9]' | sed 's/^ */  /' || true
    yellow "Browse it at http://localhost/ (port 80 — not :3000)."
}

verify_site() {
    echo "Verifying site..."
    local primary_code www_code
    primary_code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 https://circuitcenter.ai 2>/dev/null || echo "000")
    www_code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 https://www.circuitcenter.ai 2>/dev/null || echo "000")

    if [[ "$primary_code" == "200" ]]; then
        green "Primary:  https://circuitcenter.ai                    → HTTP $primary_code"
    else
        red   "Primary:  https://circuitcenter.ai                    → HTTP $primary_code (expected 200)"
    fi

    if [[ "$www_code" =~ ^30[12]$ ]]; then
        green "www:      https://www.circuitcenter.ai                → HTTP $www_code (redirect OK)"
    else
        yellow "www:      https://www.circuitcenter.ai                → HTTP $www_code (expected 301/302)"
    fi

    if [[ "$primary_code" != "200" ]]; then
        red "Primary domain is not returning 200 — check: ./deploy.sh --logs"
    fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in
    --frontend)
        check_prerequisites
        deploy_frontend
        verify_site
        ;;
    --reseed)
        check_prerequisites
        deploy_reseed
        verify_site
        ;;
    --status)
        show_status
        ;;
    --logs)
        show_logs
        ;;
    --cert-renew)
        renew_cert
        verify_site
        ;;
    pull|--pull)
        db_pull
        ;;
    --help|-h)
        sed -n '/^# Usage:/,/^# Prerequisites:/p' "$0" | sed 's/^# \?//;/^Prerequisites:/d'
        ;;
    *)
        check_prerequisites
        deploy_all
        verify_site
        ;;
esac
