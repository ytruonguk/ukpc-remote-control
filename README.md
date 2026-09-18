# UKPC Remote Control — Backend

Monorepo 4 process theo spec: `rc-api`, `rc-relay`, `rc-ingest`, `rc-web`.

## Chạy local (infra Docker, app trên máy)

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

Login mặc định: `admin` / `admin123`.

## Test (không cần máy Android)

```bash
npm test                          # unit: readiness matrix, capsHash, Annex-B
docker compose -f docker-compose.dev.yml up -d
npm run test:int                  # ingest + session + bảo mật §7 (cần infra + build nest)
npm run fake-agent -- --device-id TAB-000001 --heartbeat 5
# ffmpeg (tuỳ chọn): npm run fixtures
```

Chi tiết các tầng: unit / integration / e2e / load / chaos — `backend-test-spec.md`.

## Full stack Docker

```bash
cp .env.example .env
docker compose up --build
```

## VPS (TLS thật — HTTPS / WSS / MQTTS)

App trong Docker (bind `127.0.0.1`). Nginx **trên host**: `sites-available/rc` + stream MQTTS `:8883`.

```bash
cp .env.vps.example .env.vps   # RC_DOMAIN, JWT_SECRET, POSTGRES_PASSWORD
./scripts/vps-up.sh
sudo ./scripts/vps-nginx.sh    # dùng cert certbot sẵn có cho RC_DOMAIN
# gia hạn: sudo ./scripts/vps-renew.sh  (hoặc certbot.timer sẵn có + nginx reload)
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

## Cấu trúc

```
apps/rc-api       REST, auth, session orchestration, Headwind sync
apps/rc-relay     WebSocket byte relay (process riêng)
apps/rc-ingest    MQTT shared subscription → Redis/Postgres
apps/rc-web       React console
packages/shared   readiness, redis keys, MQTT topics
docker/           Postgres schema, EMQX ACL, Dockerfiles
```
