-- Schema order differs from the spec listing: parents must exist before FKs.

CREATE TYPE session_state AS ENUM
  ('probing','starting','active','closed','failed');

CREATE TABLE device_groups (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  hmdm_group_id INTEGER
);

CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,
  hmdm_internal_id INTEGER,
  android_id       TEXT,
  model            TEXT,
  os_version       TEXT,
  group_id         INTEGER REFERENCES device_groups(id),
  label            TEXT,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ,
  synced_at        TIMESTAMPTZ,
  stale            BOOLEAN NOT NULL DEFAULT false,
  needs_reprovisioning BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON devices (group_id);
CREATE INDEX ON devices (last_seen DESC);

CREATE TABLE device_capabilities (
  device_id         TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  agent_ver         TEXT NOT NULL,
  project_media     TEXT NOT NULL,
  a11y              BOOLEAN NOT NULL,
  knox              TEXT NOT NULL,
  overlay           BOOLEAN NOT NULL,
  secure_settings   BOOLEAN NOT NULL,
  encoder_name      TEXT,
  encoder_hw        BOOLEAN,
  caps_hash         TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capability_events (
  id         BIGSERIAL PRIMARY KEY,
  device_id  TEXT NOT NULL,
  changed    JSONB NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON capability_events (device_id, at DESC);
CREATE INDEX ON capability_events (at DESC);

CREATE TABLE operators (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT,
  hmdm_user_id  INTEGER,
  role          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(device_id),
  operator_id   INTEGER NOT NULL REFERENCES operators(id),
  relay_node    TEXT NOT NULL,
  state         session_state NOT NULL,
  entry_point   TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_at  TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  fail_reason   TEXT,
  bytes_out     BIGINT DEFAULT 0,
  input_events  INTEGER DEFAULT 0,
  peer_ip       INET
);
CREATE INDEX ON sessions (device_id, requested_at DESC);
CREATE INDEX ON sessions (operator_id, requested_at DESC);
CREATE INDEX ON sessions (state) WHERE state IN ('probing','starting','active');

CREATE TABLE operator_group_access (
  operator_id INTEGER REFERENCES operators(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES device_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (operator_id, group_id)
);
