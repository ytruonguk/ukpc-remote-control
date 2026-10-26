-- Hardware monitor (agent 1.4.7+). Idempotent so it can also be applied by hand to an existing database:
--   psql "$DATABASE_URL" -f docker/postgres/04-hw-monitor.sql

-- One row per sample. `hb` = heartbeat summary (every ~2 min), `dump` = full sample from hw.dump (~30 s apart).
CREATE TABLE IF NOT EXISTS device_hw_samples (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('hb', 'dump')),
  sample_ts   TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data        JSONB NOT NULL,
  UNIQUE (device_id, source, sample_ts)
);
CREATE INDEX IF NOT EXISTS device_hw_samples_dev_ts ON device_hw_samples (device_id, sample_ts DESC);
CREATE INDEX IF NOT EXISTS device_hw_samples_received ON device_hw_samples (received_at);

-- HW_* events from rc/event/<id>. `ts` is the device clock, `at` the server clock.
CREATE TABLE IF NOT EXISTS device_hw_events (
  id        BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  code      TEXT NOT NULL,
  msg       TEXT,
  ts        TIMESTAMPTZ NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, code, ts)
);
CREATE INDEX IF NOT EXISTS device_hw_events_dev_at ON device_hw_events (device_id, at DESC);
CREATE INDEX IF NOT EXISTS device_hw_events_at ON device_hw_events (at DESC);
