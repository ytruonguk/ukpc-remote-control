#!/usr/bin/env bash
# Drop host vhost; uses certs already issued by certbot for RC_DOMAIN.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.vps}"
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a
: "${RC_DOMAIN:?}"
: "${HOST_API_PORT:=3000}"
: "${HOST_RELAY_PORT:=3001}"
: "${HOST_WEB_PORT:=8080}"
: "${HOST_MQTT_PORT:=1883}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

LIVE="/etc/letsencrypt/live/${RC_DOMAIN}/fullchain.pem"
if [[ ! -f "$LIVE" ]]; then
  echo "No cert at $LIVE"
  echo "Issue with your certbot, then re-run:"
  echo "  certbot certonly --nginx -d ${RC_DOMAIN}"
  exit 1
fi

SITE_SRC="$ROOT/docker/proxy/sites-available/rc.conf.template"
STREAM_SRC="$ROOT/docker/proxy/stream.d/mqtts.conf.template"

mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/stream.d

if ! grep -q 'include /etc/nginx/stream.d' /etc/nginx/nginx.conf; then
  cat >> /etc/nginx/nginx.conf <<'EOF'

stream {
    include /etc/nginx/stream.d/*.conf;
}
EOF
fi

export RC_DOMAIN HOST_API_PORT HOST_RELAY_PORT HOST_WEB_PORT HOST_MQTT_PORT
envsubst '${RC_DOMAIN} ${HOST_API_PORT} ${HOST_RELAY_PORT} ${HOST_WEB_PORT}' < "$SITE_SRC" > /etc/nginx/sites-available/rc
envsubst '${RC_DOMAIN} ${HOST_MQTT_PORT}' < "$STREAM_SRC" > /etc/nginx/stream.d/mqtts.conf
ln -sfn /etc/nginx/sites-available/rc /etc/nginx/sites-enabled/rc
nginx -t
nginx -s reload

echo "Enabled /etc/nginx/sites-available/rc → https://${RC_DOMAIN}"
echo "MQTTS mqtts://${RC_DOMAIN}:8883"
