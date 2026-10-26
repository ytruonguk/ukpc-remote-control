import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { stopAllAgents } from '../tools/fake-agent/agent.js';
import { FULL_CAPS, api, closeAll, login, publishState, waitFor, waitReady } from './helpers.mjs';
import { ensureStack, stopSpawned } from './stack.mjs';

let token;
const P = `TAB-RO-${process.pid}`;
const V = { screenOn: true, charging: true, batteryPct: 90, net: 'wifi', rssi: -50 };
const HW = { thermal: 0, battTempC: 25, memAvailMb: 1500, diskFreeMb: 40000, display: 2, touchDevs: 2, mainLagMs: 5, uiIdleMs: 1000 };
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const CLI = fileURLToPath(new URL('../scripts/verify-rollout.mjs', import.meta.url));
const ids = { done: `${P}-DONE`, newer: `${P}-NEWER`, sick: `${P}-SICK`, gone: `${P}-GONE`, stuck: `${P}-STUCK`, asleep: `${P}-ASLEEP` };

before(async () => {
  await ensureStack();
  token = await login();
  const up = { caps: FULL_CAPS, volatile: { ...V, ...HW } };
  await publishState(ids.done, { ...up, agentVer: '1.4.8' });
  await publishState(ids.newer, { ...up, agentVer: '1.5.0' });
  await publishState(ids.sick, { caps: { ...FULL_CAPS, a11y: false }, volatile: { ...V, ...HW }, agentVer: '1.4.8' });
  await publishState(ids.gone, { ...up, agentVer: '1.4.8' });
  await publishState(ids.stuck, { ...up, agentVer: '1.4.3' });
  await publishState(ids.asleep, { ...up, agentVer: '1.4.3' });
  for (const id of Object.values(ids)) await waitReady(token, id);
  await publishState(ids.gone, { online: false });
  await publishState(ids.asleep, { online: false });
});

after(async () => {
  await stopAllAgents();
  await closeAll();
  await stopSpawned();
});

const list = (bucket, target = '1.4.8') => api(`/fleet/dashboard/${encodeURIComponent(`rollout:${bucket}:${target}`)}`, { token });
const has = (res, id) => res.rows.some((r) => r.deviceId === id);

test('every device is in exactly the right rollout bucket', async () => {
  const get = async (b) =>
    waitFor(async () => {
      const x = await list(b);
      return x.count > 0 && x;
    }, 8000, `${b} list`);
  assert.ok(has(await get('done'), ids.done) && has(await list('done'), ids.newer), 'on target or newer = done');
  const sick = await get('updatedUnhealthy');
  assert.ok(has(sick, ids.sick));
  assert.deepEqual(sick.rows.find((r) => r.deviceId === ids.sick).reasons, ['NO_ACCESSIBILITY']);
  assert.ok(has(await get('updatedOffline'), ids.gone), 'updated then offline');
  assert.ok(has(await get('pendingOnline'), ids.stuck), 'online but old');
  assert.ok(has(await get('pendingOffline'), ids.asleep), 'offline and old');
  // no device appears in two buckets
  const all = await Promise.all(['done', 'updatedUnhealthy', 'updatedOffline', 'pendingOnline', 'pendingOffline', 'unknown'].map((b) => list(b)));
  const seen = new Set();
  for (const b of all) for (const r of b.rows) {
    assert.ok(!seen.has(r.deviceId), `${r.deviceId} listed twice`);
    seen.add(r.deviceId);
  }
});

test('summary counts agree with the lists and the fleet is not complete', async () => {
  const r = await api('/fleet/rollout?target=1.4.8', { token });
  assert.equal(r.target, '1.4.8');
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.total);
  for (const b of Object.keys(r.counts)) assert.equal(r.counts[b], (await list(b)).count, b);
  assert.equal(r.complete, false);
  assert.ok(r.percentDone >= 0 && r.percentDone < 100);
});

test('without a target the newest version in the fleet is suggested', async () => {
  const r = await api('/fleet/rollout', { token });
  assert.match(r.target, /^\d+\.\d+\.\d+$/);
  assert.equal(r.target, r.suggestedTarget);
});

test('bad input is rejected cleanly', async () => {
  for (const t of ['abc', '1.4', '1.4.8;drop', '1.4.8-beta', '9'.repeat(40)]) {
    await assert.rejects(() => api(`/fleet/rollout?target=${encodeURIComponent(t)}`, { token }), (e) => e.status === 400, t);
  }
  for (const k of ['rollout:__proto__:1.4.8', 'rollout:constructor:1.4.8', 'rollout:done:abc', 'rollout:done', 'rollout::1.4.8']) {
    await assert.rejects(() => api(`/fleet/dashboard/${encodeURIComponent(k)}`, { token }), (e) => e.status === 404, k);
  }
  const res = await fetch(`${API}/api/fleet/rollout`);
  assert.equal(res.status, 401);
});

function cli(args, env) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 60000 });
}

test('verify-rollout exits 1 and names the problem devices while the rollout is incomplete', () => {
  const r = cli(['--target', '1.4.8'], { RC_API_URL: API, RC_USER: 'admin', RC_PASSWORD: 'admin123' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /UPDATED BUT UNHEALTHY/);
  assert.match(r.stdout, new RegExp(ids.sick));
  assert.match(r.stdout, /NO_ACCESSIBILITY/);
  assert.match(r.stdout, new RegExp(ids.stuck));
  assert.doesNotMatch(r.stdout, /COMPLETE/);
});

test('verify-rollout exits 2 on usage and auth problems and never takes credentials from argv', () => {
  assert.equal(cli([], { RC_API_URL: API }).status, 2);
  assert.equal(cli(['--target', 'oops'], { RC_API_URL: API }).status, 2);
  assert.equal(cli(['--target', '1.4.8'], { RC_API_URL: API }).status, 2, 'no credentials');
  assert.equal(cli(['--target', '1.4.8'], { RC_API_URL: API, RC_USER: 'admin', RC_PASSWORD: 'nope' }).status, 2, 'wrong password');
  const argv = cli(['--target', '1.4.8', '--password', 'x'], { RC_API_URL: API, RC_USER: 'admin' });
  assert.equal(argv.status, 2);
  assert.match(argv.stderr, /environment/);
  assert.equal(cli(['--target', '1.4.8'], { RC_API_URL: 'http://127.0.0.1:9' , RC_TOKEN: 'x' }).status, 2, 'unreachable API');
});

function cliAsync(args, env) {
  return new Promise((resolve) => {
    const c = spawn('node', [CLI, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => resolve({ status, out }));
  });
}

test('verify-rollout exits 0 only when the backend reports the rollout complete', async () => {
  let complete = true;
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/auth/login')) return res.end(JSON.stringify({ token: 't' }));
    if (req.url.startsWith('/api/fleet/rollout')) {
      return res.end(
        JSON.stringify({
          complete,
          total: 3,
          percentDone: complete ? 100 : 66.6,
          counts: { done: complete ? 3 : 2, updatedUnhealthy: 0, updatedOffline: 0, pendingOnline: complete ? 0 : 1, pendingOffline: 0, unknown: 0 },
          versions: [{ version: '1.4.8', count: 3 }],
        }),
      );
    }
    res.end(JSON.stringify({ rows: [{ deviceId: 'X', agentVer: '1.4.3', online: true, reasons: [] }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { RC_API_URL: `http://127.0.0.1:${srv.address().port}`, RC_USER: 'u', RC_PASSWORD: 'p' };
  try {
    const ok = await cliAsync(['--target', '1.4.8'], env);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /COMPLETE/);
    complete = false;
    const wait = await cliAsync(['--target', '1.4.8'], env);
    assert.equal(wait.status, 1, wait.out);
    assert.match(wait.out, /ONLINE BUT NOT UPDATED/);
    complete = true;
    const sized = await cliAsync(['--target', '1.4.8', '--expect', '3'], env);
    assert.equal(sized.status, 0, sized.out);
    const short = await cliAsync(['--target', '1.4.8', '--expect', '150'], env);
    assert.equal(short.status, 1, 'complete but only 3 of the 150 expected devices are known');
    assert.match(short.out, /INVENTORY MISMATCH/);
    assert.equal((await cliAsync(['--target', '1.4.8', '--expect', 'many'], env)).status, 2);
    complete = false;
    const json = await cliAsync(['--target', '1.4.8', '--json'], env);
    assert.equal(JSON.parse(json.out).complete, false);
  } finally {
    srv.close();
  }
});
