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

# docker without the Compose v2 plugin treats `compose -f` as docker's own -f.
# Ubuntu apt name is docker-compose-v2; docker-compose-plugin is only on Docker's repo.
ensure_compose() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    return 0
  fi
  local dest="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
  local bin="$dest/docker-compose"
  local url="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)"
  echo "Compose plugin missing; installing $url"
  mkdir -p "$dest"
  curl -fsSL "$url" -o "$bin"
  chmod +x "$bin"
  docker compose version >/dev/null
}

ensure_compose

if docker compose version >/dev/null 2>&1; then
  docker compose -f docker-compose.vps.yml --env-file "$ENV_FILE" up -d --build
else
  docker-compose -f docker-compose.vps.yml --env-file "$ENV_FILE" up -d --build
fi

echo
echo "Apps bound to 127.0.0.1 (3000 api, 3001 relay, 8080 web, 1883 mqtt)."
echo "Install host nginx: sudo ./scripts/vps-nginx.sh"
echo "Console will be https://${RC_DOMAIN}"
