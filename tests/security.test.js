import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeAgent, stopAllAgents } from '../tools/fake-agent/agent.js';
import { WebSocket } from 'ws';
import {
  api,
  closeAll,
  login,
  mqttConnect,
  mqttConnectAs,
  mqttPublish,
  mqttSubscribe,
  sleep,
  waitFor,
  waitReady,
} from './helpers.mjs';
import { ensureStack, ensureWeb, stopSpawned } from './stack.mjs';

const WEB = process.env.RC_WEB_URL ?? 'http://127.0.0.1:5174';
let token;

before(async () => {
  await ensureStack();
  await ensureWeb();
  token = await login();
});

after(async () => {
  await stopAllAgents();
  await closeAll();
  await stopSpawned();
});

async function startSession(deviceId) {
  const agent = await FakeAgent.start(deviceId, { heartbeat: 15, autoStream: false });
  await waitReady(token, deviceId);
  const s = await api('/sessions', {
    method: 'POST',
    token,
    body: { deviceId, entryPoint: 'rc_console' },
  });
  await waitFor(() => agent.pendingSession, 5000, 'session.start mqtt');
  return { agent, ...s, agentToken: agent.pendingSession.token, agentWsUrl: agent.pendingSession.wsUrl };
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

test('token expires after AGENT_JWT_EXPIRES_SEC', async () => {
  const id = `TAB-EXP-${process.pid}`;
  const s = await startSession(id);
  const ttlMs = (Number(process.env.AGENT_JWT_EXPIRES_SEC ?? 2) + 1) * 1000;
  await sleep(ttlMs);
  await assert.rejects(() =>
    connectWs(`${s.agentWsUrl}?token=${encodeURIComponent(s.agentToken)}`),
  );
  await s.agent.stop();
});

test('deep link without a session does not auto-connect', async () => {
  const res = await fetch(`${WEB}/d/TAB-022?src=hmdm`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /\/login\?next=/);
});

test('agent cannot subscribe to rc/cmd/#', async () => {
  const id = `TAB-ACL-${process.pid}`;
  const c = await mqttConnectAs(id);
  await assert.rejects(() => mqttSubscribe(c, 'rc/cmd/#'));
  await assert.rejects(() => mqttSubscribe(c, `rc/cmd/TAB-OTHER-${process.pid}`));
  await mqttSubscribe(c, `rc/cmd/${id}`);
  await new Promise((r) => c.end(true, {}, r));
});

test('agent cannot publish another device state', async () => {
  const id = `TAB-ACL2-${process.pid}`;
  const other = `TAB-OTHER-${process.pid}`;
  const backend = await mqttConnect();
  await mqttSubscribe(backend, `rc/state/${other}`);
  const seen = [];
  backend.on('message', (topic) => seen.push(topic));
  const c = await mqttConnectAs(id);
  await mqttPublish(c, `rc/state/${other}`, '{"online":true}');
  await sleep(400);
  assert.equal(seen.length, 0);
  c.end(true);
});
