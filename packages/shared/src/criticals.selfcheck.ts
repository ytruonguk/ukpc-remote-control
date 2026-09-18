import assert from 'node:assert/strict';
import { liveHashPatch } from './live-hash';
import { shouldSendViewerJoin } from './relay-join';
import { relayWsScheme } from './ws-scheme';

const heartbeat = liveHashPatch({
  ts: 1,
  volatile: { screenOn: true, charging: true, batteryPct: 50, net: 'wifi', rssi: -40 },
});
assert.equal(heartbeat.online, undefined, 'heartbeat must not clear online');
assert.equal(liveHashPatch({ ts: 1, online: false }).online, '0');
assert.equal(liveHashPatch({ ts: 1, online: true }).online, '1');

assert.equal(shouldSendViewerJoin({ peer: 'viewer', otherOpen: true }), true);
assert.equal(shouldSendViewerJoin({ peer: 'agent', otherOpen: true }), true);
assert.equal(shouldSendViewerJoin({ peer: 'agent', otherOpen: false }), false);

assert.equal(relayWsScheme({ NODE_ENV: 'production' }), 'ws');
assert.equal(relayWsScheme({ RELAY_WS_SCHEME: 'wss', NODE_ENV: 'development' }), 'wss');
assert.equal(relayWsScheme({ RELAY_WS_SCHEME: 'ws' }), 'ws');

console.log('criticals.selfcheck ok');
