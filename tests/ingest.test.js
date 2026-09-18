import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeAgent, stopAllAgents } from '../tools/fake-agent/agent.js';
import {
  FULL_CAPS,
  api,
  closeAll,
  countRows,
  getDeviceRow,
  lastEvent,
  login,
  publishState,
  redis,
  waitFor,
  waitReady,
} from './helpers.mjs';
import { ensureStack, stopSpawned } from './stack.mjs';

const SAME_CAPS = { ...FULL_CAPS };
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

test('CHỈ ghi Postgres khi capability thật sự đổi', async () => {
  const id = `TAB-DEDUP-${process.pid}`;
  await publishState(id, { caps: SAME_CAPS, volatile: { batteryPct: 90, screenOn: true, charging: true, net: 'wifi', rssi: -50 } });
  await waitReady(token, id);
  const before = await countRows('capability_events', 'device_id = $1', [id]);

  for (let i = 0; i < 50; i++) {
    await publishState(id, {
      caps: SAME_CAPS,
      volatile: { batteryPct: 90 - i, screenOn: true, charging: true, net: 'wifi', rssi: -50 },
    });
  }
  await waitFor(async () => (await redis.hget(`device:${id}`, 'batteryPct')) === '41', 5000, 'battery 41');

  assert.equal(await countRows('capability_events', 'device_id = $1', [id]), before);
});

test('ghi event khi capability đổi', async () => {
  const id = `TAB-CAPCHG-${process.pid}`;
  await publishState(id, { caps: SAME_CAPS, volatile: { batteryPct: 80, screenOn: true, charging: true, net: 'wifi', rssi: -50 } });
  await waitReady(token, id);
  await publishState(id, {
    caps: { ...SAME_CAPS, a11y: false },
    volatile: { batteryPct: 80, screenOn: true, charging: true, net: 'wifi', rssi: -50 },
  });
  const ev = await waitFor(() => lastEvent(id).then((r) => r?.changed?.a11y && r), 5000, 'caps event');
  assert.deepEqual(ev.changed.a11y, [true, false]);
});

test('LWT chuyển device sang offline khi TCP đứt', async () => {
  const id = `TAB-LWT-${process.pid}`;
  const a = await FakeAgent.start(id, { heartbeat: 30, noReconnect: true });
  await waitReady(token, id);
  a.killSocket();
  await waitFor(async () => {
    const d = await api(`/devices/${id}`, { token });
    return d.readiness.tier === 'OFFLINE';
  }, 15_000, 'LWT offline');
  await a.stop();
});

test('phát hiện factory reset', async () => {
  const id = `TAB-RST-${process.pid}`;
  await publishState(id, { androidId: 'aaa', caps: SAME_CAPS });
  await waitReady(token, id);
  await publishState(id, { androidId: 'bbb', caps: SAME_CAPS });
  const d = await waitFor(async () => {
    const row = await getDeviceRow(id);
    return row?.needs_reprovisioning ? row : null;
  }, 5000, 'needs_reprovisioning');
  assert.equal(d.needs_reprovisioning, true);
  const view = await api(`/devices/${id}`, { token });
  assert.equal(view.needsReprovisioning, true);
  assert.equal(view.readiness.tier, 'NOT_READY');
});
