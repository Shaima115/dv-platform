#!/usr/bin/env bash
# Creates the database and the four roles (migrator + one runtime role per service).
# Run once per environment by an operator with PostgreSQL superuser rights.
#   PGSUPERUSER=postgres PGSUPERPASSWORD=... bash scripts/provision-db.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${DOTENV_PATH:-$ROOT/.env}" ]]; then
  set -a; source "${DOTENV_PATH:-$ROOT/.env}"; set +a
fi

: "${PG_HOST:?PG_HOST is required}"
: "${PG_DATABASE:?PG_DATABASE is required}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD is required}"
: "${CORE_DB_PASSWORD:?CORE_DB_PASSWORD is required}"
: "${VERIFICATION_DB_PASSWORD:?VERIFICATION_DB_PASSWORD is required}"
: "${NOTIFICATION_DB_PASSWORD:?NOTIFICATION_DB_PASSWORD is required}"

export PGPASSWORD="${PGSUPERPASSWORD:-}"
psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "${PG_PORT:-5432}" -U "${PGSUPERUSER:-postgres}" -d postgres \
  -v db="$PG_DATABASE" \
  -v migrator_password="$MIGRATOR_DB_PASSWORD" \
  -v core_password="$CORE_DB_PASSWORD" \
  -v verification_password="$VERIFICATION_DB_PASSWORD" \
  -v notification_password="$NOTIFICATION_DB_PASSWORD" \
  -f "$ROOT/database/roles/001_roles.sql"
echo "database '$PG_DATABASE' and roles provisioned"
