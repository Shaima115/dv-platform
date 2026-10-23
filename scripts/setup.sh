#!/usr/bin/env bash
# One-shot setup on a plain Linux host where PostgreSQL 17, Keycloak, Nginx and PM2 are installed
# (README "Setup on a plain Linux server" explains each step and how to install the prerequisites).
# Idempotent: safe to run again. Needs sudo for the Nginx and /etc/hosts steps.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo "Create .env first: cp .env.example .env, then replace every CHANGE_ME"; exit 1; }
grep -qE '^[A-Z_]+=CHANGE_ME' .env && { echo ".env still has CHANGE_ME values"; exit 1; }
set -a; source .env; set +a
SUDO=$([[ $EUID -eq 0 ]] && echo "" || echo sudo)

step() { printf '\n==> %s\n' "$*"; }

step "Install dependencies and build"
npm ci
npm run build

step "Provision database roles (superuser) and run migrations (dv_migrator)"
PGSUPERPASSWORD="${PG_SUPERUSER_PASSWORD:-${PGSUPERPASSWORD:-}}" PGSUPERUSER="${PG_SUPERUSER:-postgres}" bash scripts/provision-db.sh
node scripts/migrate.js

step "Internal service names → private interface (${DEMO_INTERNAL_IP:-127.0.0.2})"
if ! grep -q 'svc-core.internal' /etc/hosts; then
  echo "${DEMO_INTERNAL_IP:-127.0.0.2} svc-core.internal svc-verification.internal svc-notification.internal" | $SUDO tee -a /etc/hosts >/dev/null
fi

step "Nginx public + internal listeners"
$SUDO install -m 0644 nginx/dv.conf /etc/nginx/conf.d/dv.conf
$SUDO install -d /etc/nginx/snippets
$SUDO install -m 0644 nginx/dv-internal-common.conf /etc/nginx/snippets/dv-internal-common.conf
$SUDO nginx -t
$SUDO systemctl reload nginx 2>/dev/null || $SUDO nginx -s reload 2>/dev/null || $SUDO nginx

step "Start the three APIs and two relays with PM2"
pm2 startOrReload ecosystem.config.js
pm2 save

step "Check"
bash scripts/check-environment.sh
