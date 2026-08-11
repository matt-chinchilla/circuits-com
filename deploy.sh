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
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && DOCKER_BUILDKIT=1 $COMPOSE_CMD build api calendar-reminders cost-sync && $COMPOSE_CMD up -d && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    green "All services rebuilt, nginx restarted."
}

deploy_frontend() {
    echo "Deploying frontend only..."
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && $COMPOSE_CMD up -d frontend && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    green "Frontend rebuilt, nginx restarted."
}

deploy_reseed() {
    echo "Deploying all services + clearing and reseeding database..."
    run_remote "cd $APP_DIR && sudo git pull && DOCKER_BUILDKIT=1 $COMPOSE_CMD build frontend && DOCKER_BUILDKIT=1 $COMPOSE_CMD build api calendar-reminders cost-sync && $COMPOSE_CMD up -d && $COMPOSE_CMD restart nginx && sudo docker image prune -f"
    # The calendar has to be carried across the TRUNCATE by hand.
    #
    # TRUNCATE ... CASCADE is TRANSITIVE, and the chain now reaches further than
    # it used to: suppliers -> users (users.supplier_id) -> calendar_events
    # (calendar_events.created_by_id) -> calendar_reminder_sends. So a routine
    # catalog reseed would silently delete every company meeting. `messages`
    # survives this only because nothing links it into that graph; the calendar
    # does not have that luxury, and the price of the created_by_id attribution
    # is exactly this backup.
    #
    # Same shape as the page_views/messages practice: dump to a file on the box
    # before, restore after seeding. Restored AFTER the seed so the users rows
    # the FK points at exist again; ON DELETE SET NULL means a creator who is no
    # longer seeded simply loses attribution rather than blocking the restore.
    echo "Backing up the calendar (TRUNCATE CASCADE reaches it via users)..."
    run_remote "sudo docker exec circuits-com-db-1 pg_dump -U circuits -d circuits --data-only --table=calendar_events --table=calendar_reminder_sends > /tmp/calendar-backup.sql && wc -l < /tmp/calendar-backup.sql"
    echo "Clearing database..."
    run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -c 'TRUNCATE sponsors, category_suppliers, categories, suppliers CASCADE;'"
    echo "Reseeding..."
    run_remote "sudo docker exec circuits-com-api-1 python -m app.db.seed"
    echo "Restoring the calendar..."
    run_remote "sudo docker exec -i circuits-com-db-1 psql -U circuits -d circuits -v ON_ERROR_STOP=1 < /tmp/calendar-backup.sql && sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -tAc 'SELECT count(*) FROM calendar_events;'"
    green "All services rebuilt, nginx restarted. Database cleared and reseeded; calendar restored."
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
