-- Connection diagnostics: why do devices disconnect and reconnect?
-- Idempotent; for an existing database run: psql "$DATABASE_URL" -f docker/postgres/05-conn-events.sql
--
-- source = 'broker': EMQX $SYS connected/disconnected events (authoritative reason: discarded, tcp_closed,
--                    keepalive_timeout, ...). source = 'agent': the device's own connection log.
CREATE TABLE IF NOT EXISTS device_conn_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('broker', 'agent')),
  event        TEXT NOT NULL,
  reason       TEXT,
  connected_at TIMESTAMPTZ,
  at           TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  keepalive    INTEGER,
  detail       JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, source, event, at)
);
CREATE INDEX IF NOT EXISTS device_conn_events_dev_at ON device_conn_events (device_id, at DESC);
CREATE INDEX IF NOT EXISTS device_conn_events_at ON device_conn_events (at DESC);
