#!/usr/bin/env bash
# Helpers for scripts/demo.sh: HTTP calls, token acquisition, database checks, bounded polling.
# Requires: curl, jq, psql. Development credentials only.

PASS_COUNT=0
FAIL_COUNT=0
FAILED_CHECKS=()

c_green=$'\033[32m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
[[ -t 1 ]] || { c_green=''; c_red=''; c_bold=''; c_dim=''; c_reset=''; }

scenario() { printf '\n%s== Scenario %s ==%s\n' "$c_bold" "$1" "$c_reset"; }
info() { printf '   %s%s%s\n' "$c_dim" "$*" "$c_reset"; }

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '   %sPASS%s %s\n' "$c_green" "$c_reset" "$1"; }
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CHECKS+=("$CURRENT_SCENARIO: $1")
  printf '   %sFAIL%s %s\n' "$c_red" "$c_reset" "$1"
  [[ -n "${2:-}" ]] && printf '        %s\n' "$2"
  return 0
}

# expect_eq <description> <expected> <actual>
expect_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

# api <METHOD> <URL> <TOKEN|-> [JSON body|-] [extra curl args...]
# Sets HTTP_STATUS, HTTP_BODY and HTTP_TIME (seconds).
api() {
  local method=$1 url=$2 token=$3 body=${4:--}
  shift 4 || shift $#
  local args=(-sS -X "$method" "$url" -o /tmp/dv-demo-body -w '%{http_code} %{time_total}' --max-time 20)
  [[ "$token" != "-" ]] && args+=(-H "authorization: Bearer $token")
  [[ "$body" != "-" ]] && args+=(-H 'content-type: application/json' --data "$body")
  local out
  out=$(curl "${args[@]}" "$@" 2>/dev/null) || out="000 0"
  HTTP_STATUS=${out%% *}
  HTTP_TIME=${out##* }
  HTTP_BODY=$(cat /tmp/dv-demo-body 2>/dev/null || true)
}

json() { jq -r "$1" <<<"$HTTP_BODY" 2>/dev/null; }

user_token() { # <username> <password> [client]
  curl -sS --max-time 10 "$KEYCLOAK_TOKEN_URL" -d grant_type=password -d "client_id=${3:-web}" \
    --data-urlencode "username=$1" --data-urlencode "password=$2" | jq -r '.access_token // empty'
}

service_token() { # <client_id> <secret>
  curl -sS --max-time 10 "$KEYCLOAK_TOKEN_URL" -d grant_type=client_credentials -d "client_id=$1" \
    --data-urlencode "client_secret=$2" | jq -r '.access_token // empty'
}

token_exp() { # prints the exp claim of a JWT
  local payload=${1#*.}; payload=${payload%%.*}
  # Exact padding: uutils base64 (Ubuntu 25.10+) rejects a stray '=' and prints nothing.
  case $(( ${#payload} % 4 )) in 2) payload+='==' ;; 3) payload+='=' ;; esac
  tr '_-' '/+' <<<"$payload" | base64 -d 2>/dev/null | jq -r '.exp'
}

# Each check reads a service's tables with that service's own runtime role (least privilege).
db_core()         { PGPASSWORD="$CORE_DB_PASSWORD" psql -h "$PG_HOST" -p "${PG_PORT:-5432}" -U "$CORE_DB_USER" -d "$PG_DATABASE" -tAX -c "$1"; }
db_verification() { PGPASSWORD="$VERIFICATION_DB_PASSWORD" psql -h "$PG_HOST" -p "${PG_PORT:-5432}" -U "$VERIFICATION_DB_USER" -d "$PG_DATABASE" -tAX -c "$1"; }
db_notification() { PGPASSWORD="$NOTIFICATION_DB_PASSWORD" psql -h "$PG_HOST" -p "${PG_PORT:-5432}" -U "$NOTIFICATION_DB_USER" -d "$PG_DATABASE" -tAX -c "$1"; }

# wait_for <timeout_seconds> <expected> <command...>: polls every 0.5s until output == expected.
# Prints the last value seen. Returns non-zero on timeout.
wait_for() {
  local timeout=$1 expected=$2; shift 2
  local deadline=$(( $(date +%s) + timeout )) value=''
  while (( $(date +%s) <= deadline )); do
    value=$("$@" 2>/dev/null || true)
    if [[ "$value" == "$expected" ]]; then printf '%s' "$value"; return 0; fi
    sleep 0.5
  done
  printf '%s' "$value"
  return 1
}

uuid4() { cat /proc/sys/kernel/random/uuid; }

# create_company <owner_token> <name>: sets COMPANY_ID (and HTTP_STATUS) in the current shell.
create_company() {
  api POST "$PUBLIC_URL/api/v1/companies" "$1" "{\"name\":\"$2\",\"countryCode\":\"JO\"}"
  COMPANY_ID=$(json '.id // empty')
}

company_status() { db_core "SELECT status FROM profile.company WHERE id = '$1'"; }
notification_count() { db_notification "SELECT count(*) FROM notification.notification WHERE company_id = '$1'"; }

pm2_log_file() { # <process name> → path of its stdout log
  pm2 jlist 2>/dev/null | jq -r --arg n "$1" '.[] | select(.name == $n) | .pm2_env.pm_out_log_path' | head -n1
}
