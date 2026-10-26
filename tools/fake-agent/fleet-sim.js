// Simulates a whole fleet for dashboards and load: publishes retained state for N devices over ONE MQTT connection
// (no per-device sockets). Needs a broker user allowed to publish rc/state/# (the `ingest` user in the dev ACL).
//
//   node tools/fake-agent/fleet-sim.js --count 150 --interval 60
//
// Safety: this injects fake devices into whatever broker it talks to, so it refuses a non-local broker unless
// --allow-remote is given and MQTT_USERNAME is set explicitly. To remove the fake devices afterwards:
//   DELETE FROM devices WHERE device_id LIKE 'SIM-%';   (plus their rows in device_hw_*, device_conn_events, sessions)
//
// Problems are spread deterministically by index so the dashboard always shows the same mix:
// offline devices stop being refreshed (Redis TTL 180 s turns them offline), the rest get a heartbeat every
// --interval seconds.
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const COUNT = Number(arg('count', 150));
const INTERVAL_S = Number(arg('interval', 60));
const BROKER = arg('broker', process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883');
const PREFIX = arg('prefix', 'SIM');
const host = new URL(BROKER).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
if (!local && !process.argv.includes('--allow-remote')) {
  console.error(`fleet-sim: refusing to publish fake devices to ${host}. Pass --allow-remote (and MQTT_USERNAME) if you really mean it.`);
  process.exit(2);
}
if (!local && !process.env.MQTT_USERNAME) {
  console.error('fleet-sim: set MQTT_USERNAME explicitly for a non-local broker (no default).');
  process.exit(2);
}

const FULL = { projectMedia: 'allow', a11y: true, knox: 'licensed', overlay: true, secureSettings: true };
const pad = (i) => `${PREFIX}-${String(i).padStart(3, '0')}`;

export function profile(i) {
  const caps = { ...FULL };
  const volatile = { screenOn: true, charging: true, batteryPct: 60 + (i % 40), net: 'wifi', rssi: -50 - (i % 25) };
  const hw = { thermal: 0, battTempC: 24 + (i % 6), memAvailMb: 900 + ((i * 37) % 700), diskFreeMb: 20000 + i * 50, display: 2, touchDevs: 2, mainLagMs: (i * 7) % 120, uiIdleMs: (i * 9973) % 600000 };
  let agentVer = i % 4 === 0 ? '1.4.7' : '1.4.8';
  let online = true;

  if (i % 13 === 0) online = false; // ~8% offline
  if (i % 11 === 0) caps.secureSettings = false;
  if (i % 47 === 3) caps.a11y = false;
  if (i % 37 === 5) caps.overlay = false;
  if (i % 19 === 2) hw.mainLagMs = 1800 + (i % 7) * 600; // lag
  if (i % 53 === 7) {
    hw.battTempC = 49;
    hw.thermal = 3;
  }
  if (i % 31 === 9) hw.memAvailMb = 120 + (i % 9) * 10;
  if (i % 71 === 11) hw.diskFreeMb = 150;
  if (i % 79 === 13) hw.display = 1; // panel off while the system thinks the screen is on
  if (i % 97 === 17) hw.touchDevs = 0;
  if (i % 17 === 4) hw.uiIdleMs = 7 * 3_600_000 + i * 60_000;
  if (i % 41 === 6) hw.uiIdleMs = 30 * 3_600_000;
  if (i % 23 === 8) volatile.net = 'cellular';
  if (i % 46 === 8) volatile.rssi = -108;
  if (i % 29 === 1) {
    volatile.charging = false;
    volatile.batteryPct = i % 58 === 1 ? 12 : 70;
  }
  if (i === 60) agentVer = '1.1.0'; // below the supported minimum, and too old to send hw metrics
  const sendsHw = agentVer !== '1.1.0' && i % 29 !== 2;
  return { caps, volatile, hw: sendsHw ? hw : null, agentVer, online };
}

function publishAll(client, initial) {
  for (let i = 1; i <= COUNT; i++) {
    const p = profile(i);
    if (!p.online && !initial) continue; // offline devices are not refreshed: their live state expires
    const msg = {
      online: true,
      agentVer: p.agentVer,
      androidId: `and-${pad(i)}`,
      caps: p.caps,
      volatile: { ...p.volatile, ...(p.hw ?? {}) },
      ts: Date.now(),
    };
    client.publish(`rc/state/${pad(i)}`, JSON.stringify(msg), { qos: 1, retain: false });
  }
}

const client = mqtt.connect(BROKER, {
  clientId: `fleet-sim-${randomUUID()}`,
  username: process.env.MQTT_USERNAME || 'ingest', // dev ACL user; only reachable here because the broker is local
  password: process.env.MQTT_PASSWORD || undefined,
});
client.on('error', (e) => console.error('mqtt:', e.message));
client.on('connect', () => {
  publishAll(client, true);
  console.log(`fleet-sim: ${COUNT} devices (${PREFIX}-001..), refresh every ${INTERVAL_S}s`);
});
setInterval(() => client.connected && publishAll(client, false), INTERVAL_S * 1000);
