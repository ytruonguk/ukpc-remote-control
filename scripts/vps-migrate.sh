#!/usr/bin/env bash
# Applies the database migrations in docker/postgres (files NN-name.sql with NN >= 03) that have not been
# applied yet, in order, and records them in the schema_migrations table.
#
#   ./scripts/vps-migrate.sh              apply pending migrations (this is what vps-up.sh runs)
#   ./scripts/vps-migrate.sh --status     list every migration and whether it is applied; changes nothing
#   ./scripts/vps-migrate.sh --dry-run    list only the pending ones; changes nothing
#
# 01-schema.sql and 02-seed.sql are NEVER run here: they only belong to the first start of an empty database
# (the postgres image runs them from docker-entrypoint-initdb.d), and re-running the seed would reset accounts.
#
# Rules for a migration file: idempotent where possible (IF NOT EXISTS), and no BEGIN/COMMIT of its own: each
# file runs in ONE transaction together with its schema_migrations row, so a failing file leaves nothing behind
# and later files are not attempted. (CREATE INDEX CONCURRENTLY cannot run in a transaction: do not use it here.)
#
# Exit codes: 0 ok / nothing to do, 1 a migration failed, 2 usage or environment problem (docker, database).
#
# Environment (all optional): ENV_FILE (default .env.vps), POSTGRES_USER / POSTGRES_DB (default rc),
# MIGRATIONS_DIR (default docker/postgres), COMPOSE_ARGS (replaces "-f docker-compose.vps.yml --env-file ...").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=apply
case "${1:-}" in
  ""|--apply) ;;
  --status) MODE=status ;;
  --dry-run) MODE=dry ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--status|--dry-run]" >&2; exit 2 ;;
esac

ENV_FILE="${ENV_FILE-.env.vps}"
if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
PGUSER_="${POSTGRES_USER:-rc}"
PGDB_="${POSTGRES_DB:-rc}"
DIR="${MIGRATIONS_DIR:-docker/postgres}"

if [[ -n "${COMPOSE_ARGS:-}" ]]; then
  read -r -a CARGS <<< "$COMPOSE_ARGS"
else
  CARGS=(-f docker-compose.vps.yml)
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] && CARGS+=(--env-file "$ENV_FILE")
fi
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose "${CARGS[@]}")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose "${CARGS[@]}")
else
  echo "vps-migrate: docker compose not found" >&2; exit 2
fi

die() { echo "vps-migrate: $*" >&2; exit "${2:-2}"; }
psql_() { "${DC[@]}" exec -T -e PGOPTIONS="-c client_min_messages=warning" postgres psql -X -q -U "$PGUSER_" -d "$PGDB_" -v ON_ERROR_STOP=1 "$@"; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Wait for Postgres (it may have just been started by vps-up.sh).
ready=0
for _ in $(seq 1 60); do
  if "${DC[@]}" exec -T postgres pg_isready -q -U "$PGUSER_" -d "$PGDB_" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || die "postgres is not ready (is the stack running? try: docker compose -f docker-compose.vps.yml up -d postgres)"

# The tracking table is created in every mode except it is only *written* to when applying.
psql_ -c "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())" \
  || die "cannot reach the database"
applied="$(psql_ -tA -F '|' -c "SELECT name, checksum FROM schema_migrations ORDER BY name")" || die "cannot read schema_migrations"

pending=0; done_=0; changed=0
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "$DIR" -maxdepth 1 -name '*.sql' 2>/dev/null | sort)

for f in "${files[@]:-}"; do
  [[ -n "$f" ]] || continue
  name="$(basename "$f")"
  if [[ ! "$name" =~ ^[0-9][0-9]-[A-Za-z0-9._-]+\.sql$ ]]; then
    echo "skip   $name (name must look like 06-what-it-does.sql)"; continue
  fi
  num=$((10#${name:0:2}))
  (( num >= 3 )) || continue
  sum="$(sha "$f")"
  prev="$(printf '%s\n' "$applied" | grep -F "$name|" | head -1 | cut -d'|' -f2 || true)"

  if [[ -n "$prev" ]]; then
    done_=$((done_ + 1))
    if [[ "$prev" != "$sum" ]]; then
      changed=$((changed + 1))
      echo "WARN   $name was changed after it was applied (not run again; add a new migration instead)"
    elif [[ "$MODE" == status ]]; then
      echo "ok     $name"
    fi
    continue
  fi

  pending=$((pending + 1))
  if [[ "$MODE" != apply ]]; then echo "PENDING $name"; continue; fi

  echo "apply  $name"
  if ! { cat "$f"; printf '\n'; printf '%s\n' "INSERT INTO schema_migrations (name, checksum) VALUES (:'mname', :'msum') ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();"; } \
      | psql_ --single-transaction -v mname="$name" -v msum="$sum"; then
    echo "vps-migrate: $name FAILED and was rolled back. Later migrations were not attempted." >&2
    exit 1
  fi
done

if [[ "$MODE" == apply ]]; then
  if (( pending == 0 )); then echo "migrations: up to date ($done_ applied)"; else echo "migrations: applied $pending"; fi
else
  echo "migrations: $done_ applied, $pending pending${changed:+, $changed changed}"
fi
exit 0
