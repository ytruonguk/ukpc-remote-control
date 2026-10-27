# UKPC Remote Control — Backend

[![CI](https://github.com/ytruonguk/ukpc-remote-control/actions/workflows/test.yml/badge.svg)](https://github.com/ytruonguk/ukpc-remote-control/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Four-process monorepo per spec: `rc-api`, `rc-relay`, `rc-ingest`, `rc-web`. Apache-2.0, same as the [RC Agent](https://github.com/ytruongdang/rc-agent).

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

### Database migrations

`./scripts/vps-up.sh` runs `./scripts/vps-migrate.sh` before it builds and starts the new containers. The init scripts in
`docker/postgres` only run on an empty volume, so on an existing database every file from `03-*.sql` onwards is applied
by this script instead, in order, once each (recorded in `schema_migrations`). `01-schema.sql` and `02-seed.sql` are never
re-run. If a migration fails it is rolled back, later ones are not attempted, and `vps-up.sh` stops before touching the
running containers.

```bash
./scripts/vps-migrate.sh --status    # every migration and whether it is applied
./scripts/vps-migrate.sh --dry-run   # only the pending ones
SKIP_MIGRATE=1 ./scripts/vps-up.sh   # bypass (for example while restoring a backup)
```

To add a migration create `docker/postgres/NN-what-it-does.sql` (`NN` above the last one). Keep it idempotent
(`IF NOT EXISTS`), do not put `BEGIN`/`COMMIT` in it (each file already runs in one transaction), and do not edit a file
that has been applied: add a new one instead (the script warns about changed files).

| Service | URL |
|---|---|
| rc-web | http://localhost:8080 |
| rc-api | http://localhost:3000/api/health |
| rc-relay | ws://localhost:3001/{agent,viewer} |
| rc-ingest | http://localhost:3002/health |
| EMQX dashboard | http://localhost:18083 (admin / public) |
| Postgres | localhost:5432 |
| Redis | localhost:6379 |

## Fleet dashboard

`/dashboard` in rc-web (API: `GET /fleet/dashboard`) summarises the whole fleet: connected / disconnected, permission
completeness, lag, heat, low RAM or disk, panel off, touch lost, static UI, no recent remote session, battery,
network, agent versions, hardware events and a ranked "needs attention" list. Each tile opens the list of devices
behind it. The maths lives in `packages/shared/src/dashboard.ts` (`summarizeFleet`, thresholds in `DASH_LIMITS`).

Hardware numbers only exist for agents 1.4.7+; older agents show up under "No hardware data". To see a realistic
dashboard locally: `npm run fleet-sim -- --count 150`.

## Agent rollout

`/rollout` in rc-web (API: `GET /fleet/rollout?target=1.4.8`) tracks an agent update to a target version. Every device is in
exactly one bucket: **done** (on the target or newer, online and healthy), updated but unhealthy (with the reasons), updated
but now offline (cannot be verified: it may be broken by the update), online but not updated, offline and not updated, or no
version reported. The rollout is *complete* only when every visible device is done.

The same check runs from a shell or CI. Credentials come from the environment, never from arguments:

```bash
RC_API_URL=https://<your-console> RC_USER=admin RC_PASSWORD=... npm run verify-rollout -- --target 1.4.8
npm run verify-rollout -- --target 1.4.8 --wait 90   # poll every 30 s for up to 90 minutes
npm run verify-rollout -- --target 1.4.8 --expect 150  # also fail if the inventory is not exactly 150 devices
```

Exit code `0` = complete, `1` = something is pending or unhealthy (the devices are listed), `2` = usage, login or API error.

## Layout

```
apps/rc-api       REST, auth, session orchestration, Headwind sync
apps/rc-relay     WebSocket byte relay (own process)
apps/rc-ingest    MQTT shared subscription → Redis/Postgres
apps/rc-web       React console
packages/shared   readiness, redis keys, MQTT topics
docker/           Postgres schema, EMQX ACL, Dockerfiles
```
