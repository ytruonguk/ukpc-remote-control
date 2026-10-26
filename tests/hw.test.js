import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeAgent, stopAllAgents } from '../tools/fake-agent/agent.js';
import { api, closeAll, countRows, login, redis, waitFor, waitReady } from './helpers.mjs';
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

test('heartbeat hw fields reach the device DTO and are stored', async () => {
  const id = `TAB-HW1-${process.pid}`;
  await FakeAgent.start(id, { heartbeat: 30, hw: { memAvailMb: 777, gpuPct: 40 } });
  await waitReady(token, id);
  const d = await waitFor(async () => {
    const v = await api(`/devices/${id}`, { token });
    return v.hw?.memAvailMb === 777 && v;
  }, 5000, 'hw in dto');
  assert.equal(d.hw.gpuPct, 40);
  assert.equal(d.hw.touchDevs, 2);
  await waitFor(async () => (await countRows('device_hw_samples', "device_id = $1 AND source = 'hb'", [id])) >= 1, 5000, 'hb sample');
});

test('a vanished optional hw field is removed, not left stale', async () => {
  const id = `TAB-HW2-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: { gpuPct: 40 } });
  await waitReady(token, id);
  await waitFor(async () => (await api(`/devices/${id}`, { token })).hw?.gpuPct === 40, 5000, 'gpu set');
  a.hw = { ...a.hw };
  delete a.hw.gpuPct;
  a.publishState(false);
  await waitFor(async () => {
    const v = await api(`/devices/${id}`, { token });
    return v.hw && !('gpuPct' in v.hw);
  }, 5000, 'gpu cleared');
});

test('old agents without hw fields keep hw null and do not break', async () => {
  const id = `TAB-HW3-${process.pid}`;
  await FakeAgent.start(id, { heartbeat: 30 });
  await waitReady(token, id);
  const d = await api(`/devices/${id}`, { token });
  assert.equal(d.hw, null);
  assert.equal(await countRows('device_hw_samples', 'device_id = $1', [id]), 0);
});

test('HW_ events are stored once; non-HW events are ignored', async () => {
  const id = `TAB-HW4-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {} });
  await waitReady(token, id);
  const ts = Date.now();
  a.publishHwEvent('HW_THERMAL', 'thermal=3 batt=48', ts);
  a.publishHwEvent('HW_THERMAL', 'thermal=3 batt=48', ts);
  a.publishHwEvent('H264_INIT', 'not a hw event', ts);
  a.publishHwEvent('HW_NOT_A_CODE', 'unknown', ts);
  await waitFor(async () => (await countRows('device_hw_events', 'device_id = $1', [id])) >= 1, 5000, 'event row');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await countRows('device_hw_events', 'device_id = $1', [id]), 1);
  const ev = await api(`/devices/${id}/hw/events`, { token });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].code, 'HW_THERMAL');
});

test('POST hw/dump stores samples, de-duplicates, and does not satisfy a probe', async () => {
  const id = `TAB-HW5-${process.pid}`;
  await FakeAgent.start(id, { heartbeat: 30, hw: { memAvailMb: 900 } });
  await waitReady(token, id);
  const r = await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 20 } });
  assert.equal(r.ok, true);
  assert.equal(r.count, 20);
  assert.equal(r.inserted, 20);
  assert.equal(await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id]), 20);
  assert.equal(await redis.llen(`probe:wait:${id}`), 0, 'hw dump must not land in probe:wait');
  const samples = await api(`/devices/${id}/hw?minutes=60`, { token });
  assert.ok(samples.length >= 20);
  assert.equal(samples.at(-1).memAvailMb, 900);
  const fast = await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 20 } });
  assert.deepEqual(fast, { ok: false, reason: 'THROTTLED' }, 'rapid second dump is throttled');
  await new Promise((r) => setTimeout(r, 3200));
  const again = await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 20 } });
  assert.equal(again.ok, true);
  assert.ok(again.inserted < 20, 'overlapping samples are not stored twice');
});

test('a device cannot create reply keys with an unregistered nonce', async () => {
  const id = `TAB-HW10-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {} });
  await waitReady(token, id);
  a.client.publish(`rc/probe/${id}`, JSON.stringify({ online: true, agentVer: '1.2.0', hw: a.hwSamples(2), nonce: 'evil-key', ts: Date.now() }), { qos: 1 });
  await waitFor(async () => (await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id])) >= 1, 5000, 'samples stored');
  assert.equal(await redis.exists('hw:dump:evil-key'), 0);
});

test('one bad sample does not lose the rest of a dump', async () => {
  const id = `TAB-HW11-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {} });
  await waitReady(token, id);
  const good = a.hwSamples(3);
  const bad = [{ ts: 1e18, memAvailMb: 1 }, { ts: good[0].ts + 5, fgPkg: 'a\u0000b' }, ...good];
  a.client.publish(`rc/probe/${id}`, JSON.stringify({ online: true, agentVer: '1.2.0', hw: bad, ts: Date.now() }), { qos: 1 });
  await waitFor(async () => (await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id])) === 4, 5000, 'good samples stored');
});

test('hw/dump times out for an offline device', async () => {
  const id = `TAB-HW6-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {}, noReconnect: true });
  await waitReady(token, id);
  await a.stop();
  const r = await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TIMEOUT');
});

test('PANEL_OFF event triggers one automatic dump per cooldown', async () => {
  const id = `TAB-HW7-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {} });
  await waitReady(token, id);
  a.publishHwEvent('HW_PANEL_OFF', 'display=1', Date.now());
  await waitFor(async () => (await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id])) > 0, 5000, 'auto dump');
  const n = await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id]);
  a.publishHwEvent('HW_TOUCH_GONE', 'touch=0', Date.now() + 1);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await countRows('device_hw_samples', "device_id = $1 AND source = 'dump'", [id]), n, 'cooldown suppresses a second dump');
});

test('DELETE device removes its hw rows', async () => {
  const id = `TAB-HW8-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, hw: {} });
  await waitReady(token, id);
  a.publishHwEvent('HW_LOW_MEM', 'mem low', Date.now());
  await api(`/devices/${id}/hw/dump`, { method: 'POST', token, body: { n: 3 } });
  await waitFor(async () => (await countRows('device_hw_events', 'device_id = $1', [id])) === 1, 5000, 'event');
  await api(`/devices/${id}`, { method: 'DELETE', token });
  assert.equal(await countRows('device_hw_samples', 'device_id = $1', [id]), 0);
  assert.equal(await countRows('device_hw_events', 'device_id = $1', [id]), 0);
});

test('fleet health counts online devices missing permissions', async () => {
  const id = `TAB-HW9-${process.pid}`;
  await FakeAgent.start(id, { heartbeat: 30, caps: { secureSettings: false } });
  await waitReady(token, id);
  const before = await api('/fleet/health', { token });
  assert.ok(before.missing.secureSettings >= 1);
  assert.equal(typeof before.missing.a11y, 'number');
});
