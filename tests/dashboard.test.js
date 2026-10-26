import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { stopAllAgents } from '../tools/fake-agent/agent.js';
import { FULL_CAPS, api, closeAll, login, pg, publishState, waitFor, waitReady } from './helpers.mjs';
import { ensureStack, stopSpawned } from './stack.mjs';

let token;
const P = `TAB-DB-${process.pid}`;
const V = { screenOn: true, charging: true, batteryPct: 90, net: 'wifi', rssi: -50 };
const HW = { thermal: 0, battTempC: 25, memAvailMb: 1500, diskFreeMb: 40000, display: 2, touchDevs: 2, mainLagMs: 5, uiIdleMs: 1000 };

before(async () => {
  await ensureStack();
  token = await login();
});

after(async () => {
  await stopAllAgents();
  await closeAll();
  await stopSpawned();
});

const dash = () => api('/fleet/dashboard', { token });
const inList = (d, key, id) => (d.lists[key] ?? []).includes(id);

test('dashboard classifies devices into the right buckets', async () => {
  const ids = {
    ok: `${P}-OK`,
    lag: `${P}-LAG`,
    hot: `${P}-HOT`,
    perm: `${P}-PERM`,
    panel: `${P}-PANEL`,
    touch: `${P}-TOUCH`,
    idle: `${P}-IDLE`,
    old: `${P}-OLD`,
  };
  await publishState(ids.ok, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await publishState(ids.lag, { caps: FULL_CAPS, volatile: { ...V, ...HW, mainLagMs: 3000 } });
  await publishState(ids.hot, { caps: FULL_CAPS, volatile: { ...V, ...HW, battTempC: 50, thermal: 3 } });
  await publishState(ids.perm, { caps: { ...FULL_CAPS, secureSettings: false, overlay: false }, volatile: { ...V, ...HW } });
  await publishState(ids.panel, { caps: FULL_CAPS, volatile: { ...V, ...HW, display: 1 } });
  await publishState(ids.touch, { caps: FULL_CAPS, volatile: { ...V, ...HW, touchDevs: 0 } });
  await publishState(ids.idle, { caps: FULL_CAPS, volatile: { ...V, ...HW, uiIdleMs: 30 * 3_600_000 } });
  await publishState(ids.old, { caps: FULL_CAPS, volatile: V }); // sends no hardware metrics
  for (const id of Object.values(ids)) await waitReady(token, id);

  const d = await waitFor(async () => {
    const x = await dash();
    return inList(x, 'uiIdle24h', ids.idle) && inList(x, 'noHwData', ids.old) && x;
  }, 8000, 'dashboard has the devices');

  for (const id of Object.values(ids)) assert.ok(inList(d, 'online', id), `${id} online`);
  assert.ok(inList(d, 'permissionsComplete', ids.ok));
  assert.ok(!inList(d, 'lagging', ids.ok) && !inList(d, 'hot', ids.ok) && !inList(d, 'panelOff', ids.ok) && !inList(d, 'touchGone', ids.ok));
  assert.ok(inList(d, 'lagging', ids.lag));
  assert.ok(inList(d, 'hot', ids.hot));
  assert.ok(inList(d, 'permissionsIncomplete', ids.perm) && !inList(d, 'permissionsComplete', ids.perm));
  assert.ok(inList(d, 'missingSecureSettings', ids.perm) && inList(d, 'missingOverlay', ids.perm));
  assert.ok(inList(d, 'panelOff', ids.panel));
  assert.ok(inList(d, 'touchGone', ids.touch));
  assert.ok(inList(d, 'uiIdle6h', ids.idle) && inList(d, 'uiIdle24h', ids.idle));
  assert.ok(inList(d, 'noHwData', ids.old));

  // counts agree with the lists
  assert.equal(d.performance.lagging, (d.lists.lagging ?? []).length);
  assert.equal(d.connectivity.online + d.connectivity.offline, d.total);
  assert.equal(d.tiers.READY + d.tiers.DEGRADED + d.tiers.NOT_READY + d.tiers.OFFLINE, d.total);

  const worst = d.attention.find((a) => a.deviceId === ids.panel);
  assert.ok(worst && worst.reasons.includes('PANEL_OFF'));
});

test('a device that reports offline moves to the disconnected bucket', async () => {
  const id = `${P}-GONE`;
  await publishState(id, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await waitReady(token, id);
  await publishState(id, { online: false });
  const d = await waitFor(async () => {
    const x = await dash();
    return inList(x, 'offline', id) && x;
  }, 8000, 'offline bucket');
  assert.ok(!inList(d, 'online', id));
});

test('offline for more than a day and flapping devices are reported', async () => {
  const id = `${P}-DEAD`;
  const flap = `${P}-FLAP`;
  await publishState(id, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await publishState(flap, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await waitReady(token, id);
  await waitReady(token, flap);
  await publishState(id, { online: false });
  await pg.query(`UPDATE devices SET last_seen = now() - interval '2 days' WHERE device_id = $1`, [id]);
  for (let i = 1; i <= 6; i++) {
    await pg.query(
      `INSERT INTO device_conn_events (device_id, source, event, reason, at) VALUES ($1, 'broker', 'disconnected', 'keepalive_timeout', now() - ($2 * interval '5 minutes'))`,
      [flap, i],
    );
  }
  const d = await waitFor(async () => {
    const x = await dash();
    return inList(x, 'offlineOver24h', id) && inList(x, 'flapping', flap) && x;
  }, 8000, 'offline>24h and flapping');
  assert.ok(d.stability.drops24h >= 6);
});

test('recent remote sessions clear the "no session" flag', async () => {
  const id = `${P}-SESS`;
  await publishState(id, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await waitReady(token, id);
  assert.ok(inList(await dash(), 'noSession7d', id));
  await pg.query(
    `INSERT INTO sessions (id, device_id, operator_id, relay_node, state, entry_point) VALUES (gen_random_uuid(), $1, 1, 'n1', 'closed', 'api')`,
    [id],
  );
  const d = await waitFor(async () => {
    const x = await dash();
    return !inList(x, 'noSession7d', id) && x;
  }, 5000, 'session counted');
  assert.ok(d);
});

test('dashboard requires a token', async () => {
  const res = await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/fleet/dashboard`);
  assert.equal(res.status, 401);
});

test('a metric list returns the devices behind the number, with the details that explain why', async () => {
  const perm = `${P}-LPERM`;
  const gone = `${P}-LGONE`;
  await publishState(perm, { caps: { ...FULL_CAPS, secureSettings: false, a11y: false }, volatile: { ...V, ...HW } });
  await publishState(gone, { caps: FULL_CAPS, volatile: { ...V, ...HW } });
  await waitReady(token, perm);
  await waitReady(token, gone);
  await publishState(gone, { online: false });

  const missing = await waitFor(async () => {
    const x = await api('/fleet/dashboard/permissionsIncomplete', { token });
    return x.rows.some((r) => r.deviceId === perm) && x;
  }, 8000, 'permissionsIncomplete list');
  const row = missing.rows.find((r) => r.deviceId === perm);
  assert.deepEqual([...row.missing].sort(), ['a11y', 'secureSettings']);
  assert.equal(missing.count, missing.rows.length);

  const offline = await waitFor(async () => {
    const x = await api('/fleet/dashboard/offline', { token });
    return x.rows.some((r) => r.deviceId === gone) && x;
  }, 8000, 'offline list');
  const g = offline.rows.find((r) => r.deviceId === gone);
  assert.equal(g.online, false);
  assert.equal(g.tier, 'OFFLINE');
  assert.ok(g.lastSeenMs > 0);
  assert.ok(offline.rows.every((r) => r.online === false), 'only disconnected devices are listed');

  // the number on the tile and the length of its list are the same
  const summary = await dash();
  assert.equal(summary.connectivity.offline, (await api('/fleet/dashboard/offline', { token })).count);
  assert.equal(summary.permissions.incomplete, (await api('/fleet/dashboard/permissionsIncomplete', { token })).count);
});

test('lists exist for tiers and versions, and unknown keys are rejected', async () => {
  const tier = await api('/fleet/dashboard/tier:READY', { token });
  assert.ok(tier.rows.every((r) => r.tier === 'READY'));
  const ver = await api(`/fleet/dashboard/${encodeURIComponent('ver:9.9.9')}`, { token });
  assert.equal(ver.count, 0);
  await assert.rejects(() => api('/fleet/dashboard/not-a-metric', { token }), (e) => e.status === 404);
  const res = await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/fleet/dashboard/offline`);
  assert.equal(res.status, 401);
});

test('keys that look like object properties or are malformed are rejected without a server error', async () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'ver:', `ver:${'9'.repeat(80)}`, 'ver:a/b']) {
    await assert.rejects(() => api(`/fleet/dashboard/${encodeURIComponent(key)}`, { token }), (e) => e.status === 404, key);
  }
});

test('an online device without hardware data is still ranked for attention', async () => {
  const id = `${P}-NOHW`;
  // no hw_* fields (old agent) and no capture/input path: NOT_READY, which carries a high score
  await publishState(id, { caps: { projectMedia: 'blocked', a11y: false, knox: 'unsupported', overlay: false, secureSettings: false }, volatile: V });
  const d = await waitFor(async () => {
    const x = await dash();
    return x.lists.noHwData?.includes(id) && x;
  }, 8000, 'noHwData');
  const item = d.attention.find((a) => a.deviceId === id);
  assert.ok(item, 'listed in the attention ranking');
  assert.ok(item.reasons.includes('NOT_READY'));
});
