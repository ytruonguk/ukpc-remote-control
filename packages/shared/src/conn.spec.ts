import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONN_REASON_HINT, normalizeAgentConn, normalizeBrokerEvent, parseSysClientTopic } from './conn';

test('parseSysClientTopic extracts clientId and kind', () => {
  assert.deepEqual(parseSysClientTopic('$SYS/brokers/emqx@127.0.0.1/clients/TAB-1/disconnected'), {
    clientId: 'TAB-1',
    kind: 'disconnected',
  });
  assert.equal(parseSysClientTopic('$SYS/brokers/n/clients/TAB-1/subscribed'), null);
  assert.equal(parseSysClientTopic('rc/state/TAB-1'), null);
  assert.equal(parseSysClientTopic('$SYS/brokers/n/clients/a/b/connected')?.clientId, 'a/b');
});

test('normalizeBrokerEvent reads reason, times and ip', () => {
  const e = normalizeBrokerEvent('disconnected', {
    reason: 'discarded',
    connected_at: 1000,
    disconnected_at: 2000,
    ipaddress: '10.0.0.5',
    keepalive: 60,
  });
  assert.deepEqual(e, { kind: 'disconnected', reason: 'discarded', connectedAt: 1000, at: 2000, ip: '10.0.0.5', keepalive: 60 });
  const c = normalizeBrokerEvent('connected', { connected_at: 3000, ts: 3000 });
  assert.equal(c?.reason, null);
  assert.equal(c?.at, 3000);
});

test('normalizeBrokerEvent rejects payloads without a time and cleans strings', () => {
  assert.equal(normalizeBrokerEvent('disconnected', { reason: 'x' }), null);
  assert.equal(normalizeBrokerEvent('connected', null), null);
  const e = normalizeBrokerEvent('disconnected', { disconnected_at: 5, reason: 'a\u0000b' + 'x'.repeat(200) });
  assert.ok(e && e.reason && !e.reason.includes('\u0000') && e.reason.length <= 64);
});

test('normalizeAgentConn keeps known fields only', () => {
  const e = normalizeAgentConn({ ts: 10, ev: 'disconnected', reason: 'Connection lost (32109)', upMs: 5000, net: 'wifi', rssi: -70, evil: 1 });
  assert.deepEqual(e, { ts: 10, ev: 'disconnected', reason: 'Connection lost (32109)', detail: { upMs: 5000, rssi: -70, net: 'wifi' } });
  assert.equal(normalizeAgentConn({ ev: 'x' }), null);
  assert.equal(normalizeAgentConn({ ts: 1 }), null);
});

test('every common EMQX reason has a hint', () => {
  for (const r of ['discarded', 'keepalive_timeout', 'tcp_closed', 'normal', 'kicked']) assert.ok(CONN_REASON_HINT[r]);
});
