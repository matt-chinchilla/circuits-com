#!/usr/bin/env bash
# Background frontend container rebuild on SCSS/TSX/TS edits.
# Uses flock to dedupe: only one rebuild in flight; later calls coalesce into it.
# Exits immediately; the rebuild runs detached so Claude doesn't block on the 20s cycle.
# Invoked from .claude/settings.json PostToolUse hook.
set -euo pipefail

filepath="${1:-}"
case "$filepath" in
  */frontend/src/*.scss|*/frontend/src/*.tsx|*/frontend/src/*.ts) ;;
  *) exit 0 ;;
esac

# Only trigger if the compose stack is already running — don't start containers implicitly.
if ! docker compose ps frontend --format '{{.State}}' 2>/dev/null | grep -q running; then
  exit 0
fi

lockfile="/tmp/circuits-frontend-rebuild.lock"
logfile="/tmp/circuits-frontend-rebuild.log"

(
  # Non-blocking lock acquire — if another rebuild is already running, skip.
  # The later call is redundant because the running rebuild will pick up this file too
  # (docker compose always uses the current FS state for its COPY . . step).
  flock -n 9 || exit 0
  cd /home/matthew/circuits-com
  echo "[$(date '+%H:%M:%S')] rebuild triggered by $filepath" >> "$logfile"
  docker compose up -d --build frontend >> "$logfile" 2>&1
  echo "[$(date '+%H:%M:%S')] rebuild complete" >> "$logfile"
) 9>"$lockfile" &

# Detach from the shell so the PostToolUse hook returns immediately.
disown $! 2>/dev/null || true
exit 0
