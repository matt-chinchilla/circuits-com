#!/usr/bin/env bash
# circuits --fakeuser — raise/lower the fake-presence count in the admin pill.
#
#   circuits --fakeuser --up [N]         add N fakes (default 1, DB-capped at 10)
#   circuits --fakeuser --down [N]       remove N fakes; BARE --down clears ALL
#   circuits --fakeuser --name <name>    bring ONE named roster member online
#   circuits --fakeuser --name <n> --down  take only that member offline
#   circuits --fakeuser --status         show count + named individuals
#   ... --prod                           target the live EC2 box instead of local
#
# Names are validated against FAKE_PRESENCE_ROSTER in the source (case-
# insensitive), so a typo errors with the valid list instead of silently
# showing nobody.
#
# Writes the presence_fakes singleton (migration 034) via psql — the api only
# ever READS it, so there is no endpoint and no auth surface. Fakes are the
# FICTIONAL roster in api/app/routes/admin_presence.py (FAKE_PRESENCE_ROSTER);
# they are visible to every admin viewer (demo door included) while count > 0.
set -euo pipefail

INSTANCE_ID="i-0d456bd12719e2176"
EIP="100.55.235.167"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

USAGE="usage: circuits --fakeuser --up [N] | --down [N] | --name <name> [--down] | --status  [--prod]"
PROD=0 ACTION="" N="" NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --prod) PROD=1 ;;
    --up|--down|--status) ACTION="${1#--}" ;;
    --name) shift; [ $# -gt 0 ] || { echo "$USAGE" >&2; exit 2; }; NAMES+=("$1") ;;
    [1-9]|10) N="$1" ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
  shift
done
# --name with no action means "bring them online".
if [ ${#NAMES[@]} -gt 0 ] && [ -z "$ACTION" ]; then ACTION="up"; fi
[ -n "$ACTION" ] || { echo "$USAGE" >&2; exit 2; }

# Resolve each --name against the roster in the source of truth — canonical
# casing comes back, typos die here with the valid list.
CANON=()
if [ ${#NAMES[@]} -gt 0 ]; then
  ROSTER="$(python3 - "$REPO_DIR/api/app/routes/admin_presence.py" <<'PY'
import ast, re, sys
src = open(sys.argv[1]).read()
m = re.search(r"FAKE_PRESENCE_ROSTER[^=]*=\s*(\[.*?\])", src, re.S)
print(chr(10).join(u for u, _ in ast.literal_eval(m.group(1))))
PY
)"
  for want in "${NAMES[@]}"; do
    hit="$(printf '%s
' "$ROSTER" | awk -v w="$want" 'BEGIN{IGNORECASE=0} tolower($0)==tolower(w){print; exit}')"
    if [ -z "$hit" ]; then
      echo "fakeuser: no roster member named '$want'. Valid names:" >&2
      printf '  %s
' $ROSTER >&2
      exit 2
    fi
    case "$hit" in *[!A-Za-z0-9_-]*) echo "fakeuser: refusing unsafe roster name '$hit'" >&2; exit 2 ;; esac
    CANON+=("$hit")
  done
fi

sql_array_add() {  # SQL fragment: names CSV with $1 added, deduped
  echo "array_to_string(ARRAY(SELECT DISTINCT x FROM unnest(string_to_array(names, ',') || ARRAY['$1']) AS x WHERE x <> ''), ',')"
}
sql_array_del() {  # SQL fragment: names CSV with $1 removed
  echo "array_to_string(ARRAY(SELECT x FROM unnest(string_to_array(names, ',')) AS x WHERE x <> '' AND x <> '$1'), ',')"
}

case "$ACTION" in
  up)
    if [ ${#CANON[@]} -gt 0 ]; then
      SETS=""
      for n in "${CANON[@]}"; do SETS="names = $(sql_array_add "$n"), "; SQL_PRE="${SQL_PRE:-}UPDATE presence_fakes SET $SETS updated_at = now() WHERE id = 1;"; done
      SQL="${SQL_PRE} SELECT count || '|' || names FROM presence_fakes WHERE id = 1;"
      [ -n "$N" ] && SQL="UPDATE presence_fakes SET count = LEAST(count + $N, 10) WHERE id = 1; $SQL"
    else
      N="${N:-1}"
      SQL="INSERT INTO presence_fakes (id, count, updated_at) VALUES (1, LEAST($N, 10), now())
           ON CONFLICT (id) DO UPDATE SET count = LEAST(presence_fakes.count + $N, 10), updated_at = now();
           SELECT count || '|' || names FROM presence_fakes WHERE id = 1;"
    fi ;;
  down)
    if [ ${#CANON[@]} -gt 0 ]; then
      SQL_PRE=""
      for n in "${CANON[@]}"; do SQL_PRE="${SQL_PRE}UPDATE presence_fakes SET names = $(sql_array_del "$n"), updated_at = now() WHERE id = 1;"; done
      SQL="${SQL_PRE} SELECT count || '|' || names FROM presence_fakes WHERE id = 1;"
    elif [ -n "$N" ]; then
      SQL="UPDATE presence_fakes SET count = GREATEST(count - $N, 0), updated_at = now() WHERE id = 1;
           SELECT count || '|' || names FROM presence_fakes WHERE id = 1;"
    else
      # Bare --down kills ALL fake users — count AND named (owner-specified default).
      SQL="UPDATE presence_fakes SET count = 0, names = '', updated_at = now() WHERE id = 1;
           SELECT count || '|' || names FROM presence_fakes WHERE id = 1;"
    fi ;;
  status)
    SQL="SELECT count || '|' || names FROM presence_fakes WHERE id = 1;" ;;
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

OUT="$(run_sql | head -n1 | tr -d '[:space:]')"
WHERE=$([ "$PROD" = 1 ] && echo "prod" || echo "local")
if [ -z "$OUT" ]; then
  echo "fakeuser[$WHERE]: presence_fakes row missing — run migrations (alembic 035)." >&2
  exit 1
fi
COUNT="${OUT%%|*}"; NAMED="${OUT#*|}"
MSG="fakeuser[$WHERE]: $COUNT via count"
[ -n "$NAMED" ] && MSG="$MSG + named: $NAMED"
echo "$MSG"
