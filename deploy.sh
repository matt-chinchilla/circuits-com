#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Circuits.com — Deploy Script
# ============================================================================
# Usage:
#   ./deploy.sh              Deploy latest committed changes (frontend + API)
#   ./deploy.sh --frontend   Deploy frontend only (faster)
#   ./deploy.sh --reseed     Deploy all + clear & reseed database
#   ./deploy.sh --status     Check container status on EC2
#   ./deploy.sh --logs       Tail logs from all containers
#   ./deploy.sh --cert-renew Renew Let's Encrypt SSL certificate
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
    echo "Pushing temporary SSH key via EC2 Instance Connect..."
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
    run_remote "cd $APP_DIR && sudo git pull && $COMPOSE_CMD up --build -d"
    green "All services rebuilt and restarted."
}

deploy_frontend() {
    echo "Deploying frontend only..."
    run_remote "cd $APP_DIR && sudo git pull && $COMPOSE_CMD up --build -d frontend && $COMPOSE_CMD restart nginx"
    green "Frontend rebuilt, nginx restarted."
}

deploy_reseed() {
    echo "Deploying all services + clearing and reseeding database..."
    run_remote "cd $APP_DIR && sudo git pull && $COMPOSE_CMD up --build -d"
    echo "Clearing database..."
    run_remote "sudo docker exec circuits-com-db-1 psql -U circuits -d circuits -c 'TRUNCATE sponsors, category_suppliers, categories, suppliers CASCADE;'"
    echo "Reseeding..."
    run_remote "sudo docker exec circuits-com-api-1 python -m app.db.seed"
    green "All services rebuilt. Database cleared and reseeded."
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

verify_site() {
    echo "Verifying site..."
    local primary_code legacy_code www_code
    primary_code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 https://circuits.com 2>/dev/null || echo "000")
    www_code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 https://www.circuits.com 2>/dev/null || echo "000")
    legacy_code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 https://circuits.matthew-chirichella.com 2>/dev/null || echo "000")

    if [[ "$primary_code" == "200" ]]; then
        green "Primary:  https://circuits.com                       → HTTP $primary_code"
    else
        red   "Primary:  https://circuits.com                       → HTTP $primary_code (expected 200)"
    fi

    if [[ "$www_code" =~ ^30[12]$ ]]; then
        green "www:      https://www.circuits.com                   → HTTP $www_code (redirect OK)"
    else
        yellow "www:      https://www.circuits.com                   → HTTP $www_code (expected 301/302)"
    fi

    if [[ "$legacy_code" =~ ^30[12]$ ]]; then
        green "Legacy:   https://circuits.matthew-chirichella.com   → HTTP $legacy_code (redirect OK)"
    else
        yellow "Legacy:   https://circuits.matthew-chirichella.com   → HTTP $legacy_code (expected 301/302)"
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
    --help|-h)
        head -16 "$0" | tail -14
        ;;
    *)
        check_prerequisites
        deploy_all
        verify_site
        ;;
esac
