#!/usr/bin/env bash
# Checks that the host has what the stack needs and that each dependency is reachable.
# Prints one line per check; exits non-zero if a required check fails.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "${DOTENV_PATH:-$ROOT/.env}" ]] && { set -a; source "${DOTENV_PATH:-$ROOT/.env}"; set +a; }

failures=0
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf '  warn  %s\n' "$1"; }

echo "Tools"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
(( node_major >= 20 )) && ok "node $(node -v)" || bad "node >= 20 required (found $(node -v 2>/dev/null || echo none))"
command -v npm >/dev/null && ok "npm $(npm -v)" || bad "npm missing"
command -v pm2 >/dev/null && ok "pm2 $(pm2 -v 2>/dev/null | tail -1)" || bad "pm2 missing (npm i -g pm2)"
command -v nginx >/dev/null && ok "$(nginx -v 2>&1)" || bad "nginx missing"
command -v psql >/dev/null && ok "psql $(psql --version | awk '{print $3}')" || bad "psql missing"
command -v jq >/dev/null && ok "jq" || warn "jq missing (needed by the demo)"

echo "Configuration"
[[ -f "$ROOT/.env" || -n "${DOTENV_PATH:-}" ]] && ok ".env present" || bad "no .env (cp .env.example .env and fill it in)"
grep -qE '^[A-Z_]+=CHANGE_ME' "${DOTENV_PATH:-$ROOT/.env}" 2>/dev/null && bad ".env still contains CHANGE_ME values" || ok "no CHANGE_ME placeholders"

echo "PostgreSQL"
server=$(PGPASSWORD="${CORE_DB_PASSWORD:-}" psql -h "${PG_HOST:-127.0.0.1}" -p "${PG_PORT:-5432}" -U "${CORE_DB_USER:-dv_core}" -d "${PG_DATABASE:-dv}" -tAc 'SHOW server_version' 2>/dev/null)
if [[ -n "$server" ]]; then
  ok "connected as ${CORE_DB_USER:-dv_core} (server $server)"
  [[ "${server%%.*}" == 17 ]] && ok "PostgreSQL 17" || warn "expected PostgreSQL 17, found $server"
else
  bad "cannot connect to ${PG_HOST:-?}:${PG_PORT:-5432}/${PG_DATABASE:-?} as ${CORE_DB_USER:-?} (run npm run db:provision && npm run db:migrate)"
fi

echo "Keycloak"
issuer=$(curl -s --max-time 3 "${KEYCLOAK_ISSUER:-}/.well-known/openid-configuration" | jq -r '.issuer // empty' 2>/dev/null)
[[ "$issuer" == "${KEYCLOAK_ISSUER:-}" && -n "$issuer" ]] && ok "realm jo at $issuer" || bad "realm not reachable at ${KEYCLOAK_ISSUER:-unset} (issuer must match exactly)"

echo "Internal names"
for host in svc-core svc-verification svc-notification; do
  ip=$(getent hosts "$host.internal" | awk '{print $1}')
  [[ -n "$ip" ]] && ok "$host.internal → $ip" || bad "$host.internal does not resolve (see README: internal DNS)"
done

echo "Running stack (optional)"
for host in svc-core svc-verification svc-notification; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$host.internal/ready")
  [[ "$code" == 200 ]] && ok "$host ready" || warn "$host not ready (HTTP $code)"
done

(( failures == 0 )) && echo "environment OK" || { echo "$failures required check(s) failed"; exit 1; }
