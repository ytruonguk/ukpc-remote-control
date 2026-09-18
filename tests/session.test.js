import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeAgent, stopAllAgents } from '../tools/fake-agent/agent.js';
import { FakeViewer } from '../tools/fake-agent/viewer.js';
import { WebSocket } from 'ws';
import { api, closeAll, getSessionRow, login, pg, redis, sleep, waitFor, waitReady } from './helpers.mjs';
import { ensureStack, stopSpawned } from './stack.mjs';

let token;

async function boot(deviceId, opts = {}) {
  const agent = await FakeAgent.start(deviceId, { heartbeat: 15, ...opts });
  await waitReady(token, deviceId);
  return agent;
}

async function startSession(agent) {
  const s = await api('/sessions', {
    method: 'POST',
    token,
    body: { deviceId: agent.deviceId, entryPoint: 'rc_console' },
  });
  await waitFor(() => agent.pendingSession, 5000, 'session.start mqtt');
  return { ...s, agentToken: agent.pendingSession.token, agentWsUrl: agent.pendingSession.wsUrl };
}

before(async () => {
  await ensureStack();
  token = await login();
});

after(async () => {
  await stopAllAgents();
  await closeAll();
  await stopSpawned();
});

test('Remote click → keyframe + SPS/PPS, session active', async () => {
  const id = `TAB-E2E-${process.pid}`;
  const agent = await boot(id);
  const t0 = Date.now();
  const s = await startSession(agent);
  const viewer = await FakeViewer.connect(s.wsUrl, s.token);
  await viewer.waitForFirstKeyframe(8000);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(viewer.gotCodecConfig(), true);
  const row = await waitFor(async () => {
    const r = await getSessionRow(s.sessionId);
    return r?.state === 'active' ? r : null;
  }, 5000, 'session active');
  assert.equal(row.state, 'active');
  viewer.close();
  await agent.stop();
});

test('late viewer receives cached SPS/PPS', async () => {
  const id = `TAB-LATE-${process.pid}`;
  const agent = await boot(id);
  const s = await startSession(agent);
  const v1 = await FakeViewer.connect(s.wsUrl, s.token);
  await v1.waitForFirstKeyframe(5000);
  v1.close();
  await sleep(1000);
  const v2 = await FakeViewer.connect(s.wsUrl, s.token);
  await sleep(400);
  assert.equal(v2.gotCodecConfig(), true);
  v2.close();
  await agent.stop();
});

test('mid-GOP viewer gets a keyframe in under 1 second', async () => {
  const id = `TAB-GOP-${process.pid}`;
  const agent = await boot(id);
  const s = await startSession(agent);
  const v1 = await FakeViewer.connect(s.wsUrl, s.token);
  await v1.waitForFirstKeyframe(5000);
  await sleep(1200);
  const v2 = await FakeViewer.connect(s.wsUrl, s.token);
  await v2.waitForFirstKeyframe(3000);
  assert.ok(v2.firstKeyframeLatency() < 1000);
  v1.close();
  v2.close();
  await agent.stop();
});

test('detects when the agent skips viewerJoin', async () => {
  const id = `TAB-NOJOIN-${process.pid}`;
  const agent = await boot(id, { ignoreViewerJoin: true });
  const s = await startSession(agent);
  await waitFor(() => agent.streamStartedAt, 5000, 'stream start');
  await sleep(400);
  const v = await FakeViewer.connect(s.wsUrl, s.token);
  await v.waitForFirstKeyframe(4000);
  assert.ok(v.firstKeyframeLatency() > 800);
  v.close();
  await agent.stop();
});

test('second session is rejected with 409', async () => {
  const id = `TAB-BUSY-${process.pid}`;
  const agent = await boot(id);
  await startSession(agent);
  await assert.rejects(
    () => api('/sessions', { method: 'POST', token, body: { deviceId: id, entryPoint: 'rc_console' } }),
    (e) => e.status === 409 && e.code === 'DEVICE_BUSY',
  );
  await agent.stop();
});

test('agent dies mid-session → closed, lock released', async () => {
  const id = `TAB-CH1-${process.pid}`;
  const agent = await boot(id);
  const s = await startSession(agent);
  const viewer = await FakeViewer.connect(s.wsUrl, s.token);
  await viewer.waitForFirstKeyframe(8000);
  await agent.stop();
  const row = await waitFor(async () => {
    const r = await getSessionRow(s.sessionId);
    return r?.state === 'closed' ? r : null;
  }, 5000, 'session closed');
  assert.equal(row.state, 'closed');
  assert.equal(await redis.get(`device:activeSession:${id}`), null);
  viewer.close();
});

test('10 concurrent requests, only 1 wins', async () => {
  const id = `TAB-RACE-${process.pid}`;
  const agent = await boot(id);
  const rs = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      api('/sessions', { method: 'POST', token, body: { deviceId: id, entryPoint: 'rc_console' } }),
    ),
  );
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  await agent.stop();
});

test('API rejects requests without a token', async () => {
  const res = await fetch('http://127.0.0.1:3000/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'TAB-022' }),
  });
  assert.equal(res.status, 401);
});

test('NOT_READY → 422 with blocker', async () => {
  const id = `TAB-NR-${process.pid}`;
  const agent = await FakeAgent.start(id, { heartbeat: 15, caps: agentCapsBlocked() });
  await waitFor(async () => {
    const d = await api(`/devices/${id}`, { token });
    return d.readiness.tier === 'NOT_READY';
  }, 8000, 'not ready');
  await assert.rejects(
    () => api('/sessions', { method: 'POST', token, body: { deviceId: id, entryPoint: 'rc_console' } }),
    (e) => e.status === 422 && (e.code === 'NOT_READY' || e.body?.blockers),
  );
  await agent.stop();
});

test('agent token is single-use', async () => {
  const id = `TAB-JTI-${process.pid}`;
  const agent = await boot(id, { autoStream: false });
  const s = await startSession(agent);
  const ws1 = await connectWs(`${s.agentWsUrl}?token=${encodeURIComponent(s.agentToken)}`);
  assert.equal(ws1.readyState, WebSocket.OPEN);
  await assert.rejects(() => connectWs(`${s.agentWsUrl}?token=${encodeURIComponent(s.agentToken)}`));
  ws1.close();
  await agent.stop();
});

test('probe slower than 3s → FAILED device_unreachable', async () => {
  const id = `TAB-SLOW-${process.pid}`;
  const agent = await FakeAgent.start(id, { heartbeat: 15, probeDelay: 5000 });
  await waitReady(token, id);
  await assert.rejects(
    () => api('/sessions', { method: 'POST', token, body: { deviceId: id, entryPoint: 'rc_console' } }),
    (e) => e.status === 422 && (e.code === 'FAILED' || e.body?.failReason === 'device_unreachable'),
  );
  await agent.stop();
});

const ADMIN_HASH = '$2b$10$YmnkDiEgykVKOPr64kweg.x.n/b1D6Yj0nmH83YpSQHsZuiuVh.2.';

test('operator not in group → 403', async () => {
  const id = `TAB-RBAC-${process.pid}`;
  const agent = await boot(id);
  const username = `op_north_${process.pid}`;
  await pg.query(
    `INSERT INTO operators (username, display_name, password_hash, role, active)
     VALUES ($1, $1, $2, 'operator', true)
     ON CONFLICT (username) DO NOTHING`,
    [username, ADMIN_HASH],
  );
  const tok = await login(username, 'admin123');
  await assert.rejects(
    () => api('/sessions', { method: 'POST', token: tok, body: { deviceId: id, entryPoint: 'rc_console' } }),
    (e) => e.status === 403,
  );
  await agent.stop();
});

function agentCapsBlocked() {
  return { projectMedia: 'blocked', a11y: false, knox: 'unlicensed', overlay: false, secureSettings: false };
}

function connectWs(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) resolve(ws);
      else fail(new Error(`ws not open (${ws.readyState})`));
    }, 200);
    ws.once('error', fail);
    ws.once('close', (code, reason) => fail(new Error(`ws close ${code} ${reason}`)));
  });
}
