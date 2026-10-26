import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeAgent, stopAllAgents } from '../tools/fake-agent/agent.js';
import { api, closeAll, countRows, login, mqttConnectAs, pg, waitFor, waitReady } from './helpers.mjs';
import { ensureStack, stopSpawned } from './stack.mjs';

let token;

before(async () => {
  await ensureStack();
  token = await login();
});

after(async () => {
  await stopAllAgents();
  await closeAll();
  await stopSpawned();
});

const brokerReasons = async (id) =>
  (await pg.query(`SELECT reason FROM device_conn_events WHERE device_id = $1 AND source = 'broker' AND event = 'disconnected'`, [id])).rows.map((r) => r.reason);

test('a second client with the same clientId is recorded as "discarded"', async () => {
  const id = `TAB-CN1-${process.pid}`;
  await FakeAgent.start(id, { heartbeat: 30, noReconnect: true });
  await waitReady(token, id);
  const dup = await mqttConnectAs(id); // clean start, same clientId: classic duplicate device_id
  await waitFor(async () => (await brokerReasons(id)).includes('discarded'), 5000, 'discarded recorded');
  dup.end(true);
});

test('an abrupt TCP drop is recorded as "tcp_closed" and shows in the API', async () => {
  const id = `TAB-CN2-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, noReconnect: true });
  await waitReady(token, id);
  a.killSocket();
  await waitFor(async () => (await brokerReasons(id)).includes('tcp_closed'), 5000, 'tcp_closed recorded');
  const c = await api(`/devices/${id}/conn?hours=1`, { token });
  assert.ok(c.disconnects >= 1);
  const r = c.byReason.find((x) => x.reason === 'tcp_closed');
  assert.ok(r && r.count >= 1 && r.hint, 'reason has a human hint');
  assert.ok(c.events.some((e) => e.source === 'broker' && e.event === 'disconnected'));
  const fleet = await api('/fleet/connections?hours=1', { token });
  assert.ok(fleet.byReason.some((x) => x.reason === 'tcp_closed'));
  assert.ok(fleet.topDevices.some((d) => d.deviceId === id));
});

test('connections from non-device clients (api, ingest, strangers) are not stored', async () => {
  const stranger = `not-a-device-${process.pid}`;
  const c = await mqttConnectAs(stranger);
  c.end(true);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await countRows('device_conn_events', 'device_id = $1', [stranger]), 0);
});

test('agent MQTT_FLAP events are stored with their summary', async () => {
  const id = `TAB-CN3-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30 });
  await waitReady(token, id);
  a.client.publish(`rc/event/${id}`, JSON.stringify({ t: 'event', code: 'MQTT_FLAP', msg: '5 drops/10min: Connection lost x3', ts: Date.now() }), { qos: 1 });
  const row = await waitFor(async () => {
    const r = await pg.query(`SELECT reason FROM device_conn_events WHERE device_id = $1 AND source = 'agent' AND event = 'flap'`, [id]);
    return r.rows[0];
  }, 5000, 'flap stored');
  assert.match(row.reason, /Connection lost/);
});

test('the agent connection log in a hw.dump reply is stored and shown', async () => {
  const id = `TAB-CN4-${process.pid}`;
  const t = Date.now() - 5000;
  await FakeAgent.start(id, {
    heartbeat: 30,
    hw: {},
    connLog: [
      { ts: t, ev: 'disconnected', reason: 'Connection lost (32109)', upMs: 4000, net: 'wifi', rssi: -71 },
      { ts: t + 2000, ev: 'connect_ok', attempt: 1, delayMs: 2000, net: 'wifi' },
    ],
  });
  await waitReady(token, id);
  const r = await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 3 } });
  assert.equal(r.ok, true);
  const c = await waitFor(async () => {
    const v = await api(`/devices/${id}/conn?hours=1`, { token });
    return v.events.some((e) => e.source === 'agent' && e.event === 'disconnected') && v;
  }, 5000, 'agent conn stored');
  const ev = c.events.find((e) => e.source === 'agent' && e.event === 'disconnected');
  assert.equal(ev.reason, 'Connection lost (32109)');
  assert.equal(ev.detail.upMs, 4000);
});

test('an unknown device returns 404 for /conn', async () => {
  await assert.rejects(() => api('/devices/NO-SUCH-DEVICE/conn', { token }), (e) => e.status === 404);
});
