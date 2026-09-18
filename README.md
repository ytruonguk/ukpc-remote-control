# UKPC Remote Control — Backend

Four-process monorepo per spec: `rc-api`, `rc-relay`, `rc-ingest`, `rc-web`.

## Local (Docker infra, apps on the host)

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npm run build:shared
npm run dev:api      # :3000
npm run dev:relay    # :3001
npm run dev:ingest   # :3002
npm run dev:web      # :5173
```

Default login: `admin` / `admin123`.

## Tests (no Android device required)

```bash
npm test                          # unit: readiness matrix, capsHash, Annex-B
docker compose -f docker-compose.dev.yml up -d
npm run test:int                  # ingest + session + security §7 (needs infra + nest build)
npm run fake-agent -- --device-id TAB-000001 --heartbeat 5
# ffmpeg (optional): npm run fixtures
```

Layer details: unit / integration / e2e / load / chaos — `backend-test-spec.md`.

## Full stack Docker

```bash
cp .env.example .env
docker compose up --build
```

## VPS (real TLS — HTTPS / WSS / MQTTS)

Apps run in Docker (bound to `127.0.0.1`). Nginx **on the host**: `sites-available/rc` + MQTTS stream on `:8883`.

```bash
cp .env.vps.example .env.vps   # RC_DOMAIN, JWT_SECRET, POSTGRES_PASSWORD
./scripts/vps-up.sh
sudo ./scripts/vps-nginx.sh    # use existing certbot cert for RC_DOMAIN
# renew: sudo ./scripts/vps-renew.sh  (or existing certbot.timer + nginx reload)
```

Agent: `mqtts://RC_DOMAIN:8883`. Console: `https://RC_DOMAIN`.

| Service | URL |
|---|---|
| rc-web | http://localhost:8080 |
| rc-api | http://localhost:3000/api/health |
| rc-relay | ws://localhost:3001/{agent,viewer} |
| rc-ingest | http://localhost:3002/health |
| EMQX dashboard | http://localhost:18083 (admin / public) |
| Postgres | localhost:5432 |
| Redis | localhost:6379 |

## Layout

```
apps/rc-api       REST, auth, session orchestration, Headwind sync
apps/rc-relay     WebSocket byte relay (own process)
apps/rc-ingest    MQTT shared subscription → Redis/Postgres
apps/rc-web       React console
packages/shared   readiness, redis keys, MQTT topics
docker/           Postgres schema, EMQX ACL, Dockerfiles
```
