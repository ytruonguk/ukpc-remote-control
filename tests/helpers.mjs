import net from 'node:net';
import { Pool } from 'pg';
import Redis from 'ioredis';
import mqtt from 'mqtt';

export const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
export const FULL_CAPS = {
  projectMedia: 'allow',
  a11y: true,
  knox: 'licensed',
  overlay: true,
  secureSettings: true,
};

export const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://rc:rc@localhost:5432/rc' });
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

let mqttClient;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, ms = 8000, label = 'waitFor') {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`${label} timeout: ${String(last)}`);
}

export function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

export async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message?.code ?? json.code ?? res.statusText);
    err.status = res.status;
    err.body = json.message ?? json;
    err.code = json.message?.code ?? json.code;
    throw err;
  }
  return json;
}

export async function login(username = 'admin', password = 'admin123') {
  const res = await api('/auth/login', { method: 'POST', body: { username, password } });
  return res.token;
}

export async function mqttConnect() {
  if (mqttClient?.connected) return mqttClient;
  mqttClient = mqtt.connect(process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883', {
    clientId: `rc-test-${process.pid}`,
    username: process.env.MQTT_USERNAME || 'ingest',
    password: process.env.MQTT_PASSWORD || undefined,
  });
  await new Promise((resolve, reject) => {
    mqttClient.once('connect', resolve);
    mqttClient.once('error', reject);
  });
  return mqttClient;
}

export async function mqttConnectAs(deviceId) {
  const c = mqtt.connect(process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883', {
    clientId: deviceId,
    username: deviceId,
    clean: true,
    reconnectPeriod: 0,
  });
  c.on('error', () => {});
  await new Promise((resolve, reject) => {
    c.once('connect', resolve);
    c.once('error', reject);
  });
  return c;
}

export function mqttSubscribe(client, topic) {
  return new Promise((resolve, reject) => {
    const ret = client.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) return reject(err);
      const qos = granted?.[0]?.qos;
      if (qos === undefined || qos > 2) return reject(new Error(`sub denied ${topic}`));
      resolve(granted);
    });
    if (ret && typeof ret.then === 'function') ret.catch(() => {});
  });
}

export function mqttPublish(client, topic, payload = '{}') {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
}

export async function publishState(deviceId, msg) {
  const c = await mqttConnect();
  const payload = {
    online: true,
    agentVer: '1.2.0',
    ts: Date.now(),
    ...msg,
  };
  await new Promise((resolve, reject) => {
    c.publish(`rc/state/${deviceId}`, JSON.stringify(payload), { qos: 1, retain: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

export async function countRows(table, where, params = []) {
  const sql = where ? `SELECT count(*)::int AS n FROM ${table} WHERE ${where}` : `SELECT count(*)::int AS n FROM ${table}`;
  const { rows } = await pg.query(sql, params);
  return rows[0].n;
}

export async function lastEvent(deviceId) {
  const { rows } = await pg.query(
    `SELECT * FROM capability_events WHERE device_id = $1 ORDER BY id DESC LIMIT 1`,
    [deviceId],
  );
  return rows[0];
}

export async function getSessionRow(id) {
  const { rows } = await pg.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return rows[0];
}

export async function getDeviceRow(deviceId) {
  const { rows } = await pg.query(`SELECT * FROM devices WHERE device_id = $1`, [deviceId]);
  return rows[0];
}

export async function waitReady(token, deviceId, ms = 8000) {
  return waitFor(async () => {
    const d = await api(`/devices/${deviceId}`, { token });
    return d.readiness.tier === 'READY' || d.readiness.tier === 'DEGRADED' ? d : null;
  }, ms, `ready ${deviceId}`);
}

export async function closeAll() {
  await pg.end();
  await redis.quit();
  if (mqttClient) {
    await new Promise((r) => mqttClient.end(true, {}, r));
    mqttClient = null;
  }
}
