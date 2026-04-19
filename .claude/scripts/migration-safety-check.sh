#!/usr/bin/env bash
# PreToolUse Bash hook — flags `git commit` invocations where a new Alembic
# migration is staged but NO api/app/models/*.py change accompanies it.
#
# Common root causes for this pattern:
#   1. `alembic revision --autogenerate` was run against a drifted DB state
#      (e.g., a column you already added by hand made it into the migration).
#   2. The model edit was committed in an earlier commit (OK — but the
#      migration commit loses its self-describing history).
#   3. This is a hand-written data migration (OK — proceed).
#
# Output: JSON on stdout for PreToolUse to consume. `decision: "ask"` surfaces
# a confirmation prompt; the user proceeds or aborts.

set -euo pipefail

command="${1:-}"
# Only act on git-commit command forms
if ! echo "$command" | grep -qE '(^|[[:space:];&|])git +commit\b'; then
  exit 0
fi

# Staged files — bail if git is not available or no repo context
if ! staged=$(git diff --cached --name-only 2>/dev/null); then
  exit 0
fi
[[ -z "$staged" ]] && exit 0

# New migrations = files under api/alembic/versions/ with status A (added)
new_migrations=$(git diff --cached --name-status 2>/dev/null \
  | awk '$1 == "A" && $2 ~ /^api\/alembic\/versions\/.+\.py$/ { print $2 }')

# Model changes = any modification to api/app/models/*.py
model_changes=$(echo "$staged" | grep -E '^api/app/models/.+\.py$' || true)

if [[ -n "$new_migrations" && -z "$model_changes" ]]; then
  # Summarize staged files for the prompt (first 10)
  staged_summary=$(echo "$staged" | head -10 | sed 's/^/    /')
  migrations_summary=$(echo "$new_migrations" | sed 's/^/    /')
  reason=$(cat <<EOF
Migration safety check — new Alembic migration(s) staged WITHOUT any model change in the same commit.

New migrations:
$migrations_summary

All staged files (first 10):
$staged_summary

Usually this means one of:
  1. autogenerate caught drift from a hand-edited DB (likely wrong)
  2. Model edit was committed in an earlier commit (OK but history fragments)
  3. Hand-written data migration (OK — proceed)

Proceed only if intent matches (2) or (3).
EOF
)
  # Use jq to build valid JSON
  jq -n --arg reason "$reason" '{decision: "ask", reason: $reason}'
  exit 0
fi

# No mismatch — silent pass
exit 0
