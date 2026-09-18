#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env.vps}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.vps.example and set RC_DOMAIN, JWT_SECRET, POSTGRES_PASSWORD."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${RC_DOMAIN:?}"
: "${JWT_SECRET:?}"
: "${POSTGRES_PASSWORD:?}"

docker compose -f docker-compose.vps.yml --env-file "$ENV_FILE" up -d --build

echo
echo "Apps bound to 127.0.0.1 (3000 api, 3001 relay, 8080 web, 1883 mqtt)."
echo "Install host nginx: sudo ./scripts/vps-nginx.sh"
echo "Console will be https://${RC_DOMAIN}"
