import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DASH_LIMITS, briefOf, summarizeFleet, type DashRow } from './dashboard';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const FULL = { projectMedia: 'allow', a11y: true, knox: 'licensed', overlay: true, secureSettings: true } as const;

function row(id: string, over: Partial<DashRow> = {}): DashRow {
  return {
    deviceId: id,
    label: null,
    group: 'default',
    online: true,
    lastSeenMs: NOW - 1000,
    agentVer: '1.4.8',
    caps: { ...FULL },
    needsReprovisioning: false,
    volatile: { screenOn: true, charging: true, batteryPct: 90, net: 'wifi', rssi: -55 },
    hw: { thermal: 0, battTempC: 25, memAvailMb: 1500, diskFreeMb: 40000, display: 2, touchDevs: 2, mainLagMs: 5, uiIdleMs: 1000 },
    lastSessionMs: NOW - H,
    drops24h: 0,
    hwEvents24h: [],
    ...over,
  };
}

test('a healthy fleet has no problems', () => {
  const d = summarizeFleet([row('A'), row('B')], NOW);
  assert.equal(d.total, 2);
  assert.equal(d.connectivity.online, 2);
  assert.equal(d.permissions.complete, 2);
  assert.equal(d.tiers.READY, 2);
  assert.equal(d.attention.length, 0);
  assert.equal(d.performance.lagging, 0);
});

test('online vs offline, and offline for more than a day', () => {
  const d = summarizeFleet(
    [row('ON'), row('OFF1', { online: false, lastSeenMs: NOW - 2 * H }), row('OFF2', { online: false, lastSeenMs: NOW - 30 * H }), row('NEW', { online: false, lastSeenMs: null })],
    NOW,
  );
  assert.deepEqual(d.connectivity, { online: 1, offline: 3, offlineOver24h: 1, neverSeen: 1 });
  assert.deepEqual(d.lists.offlineOver24h, ['OFF2']);
  assert.equal(d.tiers.OFFLINE, 3);
});

test('permissions: complete, incomplete by kind, and unknown caps', () => {
  const d = summarizeFleet(
    [
      row('OK'),
      row('NOSS', { caps: { ...FULL, secureSettings: false } }),
      row('NOA11Y', { caps: { ...FULL, a11y: false } }),
      row('BOTH', { caps: { ...FULL, secureSettings: false, overlay: false } }),
      row('NEVER', { caps: null, online: false }),
    ],
    NOW,
  );
  assert.equal(d.permissions.complete, 1);
  assert.equal(d.permissions.incomplete, 3);
  assert.equal(d.permissions.unknown, 1);
  assert.equal(d.permissions.missingSecureSettings, 2);
  assert.equal(d.permissions.missingA11y, 1);
  assert.equal(d.permissions.missingOverlay, 1);
});

test('lag, heat, memory, disk and panel/touch problems are counted only for online devices with hw data', () => {
  const d = summarizeFleet(
    [
      row('LAG', { hw: { mainLagMs: DASH_LIMITS.lagMs } }),
      row('FINE', { hw: { mainLagMs: DASH_LIMITS.lagMs - 1 } }),
      row('HOT', { hw: { battTempC: 48 } }),
      row('THROTTLED', { hw: { thermal: 3 } }),
      row('MEM', { hw: { memAvailMb: 100 } }),
      row('DISK', { hw: { diskFreeMb: 50 } }),
      row('PANEL', { hw: { display: 1 } }),
      row('TOUCH', { hw: { touchDevs: 0 } }),
      row('OLD', { hw: null }),
      row('GONE', { online: false, hw: { mainLagMs: 9000 } }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists.lagging, ['LAG']);
  assert.deepEqual(d.lists.hot.sort(), ['HOT', 'THROTTLED']);
  assert.deepEqual(d.lists.lowMem, ['MEM']);
  assert.deepEqual(d.lists.lowDisk, ['DISK']);
  assert.deepEqual(d.lists.panelOff, ['PANEL']);
  assert.deepEqual(d.lists.touchGone, ['TOUCH']);
  assert.deepEqual(d.lists.noHwData, ['OLD']);
});

test('panel off only counts when the system thinks the screen is on', () => {
  const d = summarizeFleet([row('P', { hw: { display: 1 }, volatile: { screenOn: false, charging: true, batteryPct: 80, net: 'wifi', rssi: -50 } })], NOW);
  assert.equal(d.performance.panelOff, 0);
});

test('interaction: ui idle buckets and no recent remote session', () => {
  const d = summarizeFleet(
    [
      row('IDLE7', { hw: { uiIdleMs: 7 * H } }),
      row('IDLE25', { hw: { uiIdleMs: 25 * H } }),
      row('BUSY', { hw: { uiIdleMs: 5000 } }),
      row('UNKNOWN', { hw: { memAvailMb: 1000 } }),
      row('SESSION_OLD', { lastSessionMs: NOW - 9 * 24 * H }),
      row('SESSION_NEVER', { lastSessionMs: null }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists.uiIdle6h.sort(), ['IDLE25', 'IDLE7']);
  assert.deepEqual(d.lists.uiIdle24h, ['IDLE25']);
  assert.deepEqual(d.lists.noSession7d.sort(), ['SESSION_NEVER', 'SESSION_OLD']);
  assert.equal(d.interaction.uiIdle6h, 2);
});

test('battery, network and weak cellular signal', () => {
  const d = summarizeFleet(
    [
      row('LOWBAT', { volatile: { screenOn: true, charging: false, batteryPct: 10, net: 'wifi', rssi: -50 } }),
      row('UNPLUGGED', { volatile: { screenOn: true, charging: false, batteryPct: 80, net: 'wifi', rssi: -50 } }),
      row('CELL', { volatile: { screenOn: true, charging: true, batteryPct: 90, net: 'cellular', rssi: -110 } }),
      row('ETH', { volatile: { screenOn: true, charging: true, batteryPct: 90, net: 'ethernet', rssi: 0 } }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists.lowBattery, ['LOWBAT']);
  assert.deepEqual(d.lists.notCharging.sort(), ['LOWBAT', 'UNPLUGGED']);
  assert.deepEqual(d.network, { wifi: 2, cellular: 1, ethernet: 1, unknown: 0, weakSignal: 1 });
});

test('versions are grouped and devices below the minimum are outdated', () => {
  const d = summarizeFleet([row('A'), row('B'), row('C', { agentVer: '1.4.7' }), row('D', { agentVer: '1.1.0' })], NOW);
  assert.deepEqual(d.versions[0], { version: '1.4.8', count: 2 });
  assert.deepEqual(d.lists.outdated, ['D']);
});

test('flapping devices and event counts', () => {
  const d = summarizeFleet(
    [
      row('F', { drops24h: 12, hwEvents24h: ['HW_PANEL_OFF', 'HW_PANEL_OFF'] }),
      row('G', { drops24h: 2, hwEvents24h: ['HW_PANEL_OFF', 'HW_LOW_MEM'] }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists.flapping, ['F']);
  assert.equal(d.stability.drops24h, 14);
  assert.deepEqual(d.events24h, [
    { code: 'HW_PANEL_OFF', devices: 2 },
    { code: 'HW_LOW_MEM', devices: 1 },
  ]);
});

test('attention list ranks the worst devices first and is capped', () => {
  const rows = [
    row('MILD', { hw: { mainLagMs: 2000 } }),
    row('BLACK', { hw: { display: 1, touchDevs: 0, mainLagMs: 3000 } }),
    ...Array.from({ length: 40 }, (_, i) => row(`L${String(i).padStart(2, '0')}`, { hw: { mainLagMs: 5000 } })),
  ];
  const d = summarizeFleet(rows, NOW, 10);
  assert.equal(d.attention[0].deviceId, 'BLACK');
  assert.ok(d.attention[0].reasons.includes('PANEL_OFF') && d.attention[0].reasons.includes('TOUCH_GONE'));
  assert.equal(d.attention.length, 10);
});

test('offline devices with problems still appear in attention', () => {
  const d = summarizeFleet([row('DEAD', { online: false, lastSeenMs: NOW - 48 * H, caps: { ...FULL, a11y: false } })], NOW);
  assert.equal(d.attention[0].deviceId, 'DEAD');
  assert.ok(d.attention[0].reasons.includes('OFFLINE_OVER_24H'));
});

test('every tile has a list behind it: tiers, never seen, network kinds and versions', () => {
  const d = summarizeFleet(
    [
      row('A'),
      row('B', { online: false, lastSeenMs: null }),
      row('C', { volatile: { screenOn: true, charging: true, batteryPct: 90, net: 'cellular', rssi: -60 } }),
      row('D', { agentVer: '1.4.7' }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists['tier:OFFLINE'], ['B']);
  assert.deepEqual(d.lists['tier:READY'].sort(), ['A', 'C', 'D']);
  assert.deepEqual(d.lists.neverSeen, ['B']);
  assert.deepEqual(d.lists.cellular, ['C']);
  assert.deepEqual(d.lists.wifi.sort(), ['A', 'D']);
  assert.deepEqual(d.lists['ver:1.4.7'], ['D']);
  // counts shown on the tiles equal the list lengths
  assert.equal(d.connectivity.neverSeen, d.lists.neverSeen.length);
  assert.equal(d.network.cellular, d.lists.cellular.length);
});

test('briefOf lists exactly which permissions are missing', () => {
  const miss = briefOf(row('M', { caps: { ...FULL, secureSettings: false, overlay: false } }));
  assert.deepEqual(miss.missing, ['secureSettings', 'overlay']);
  assert.deepEqual(briefOf(row('OK')).missing, []);
  assert.equal(briefOf(row('NEVER', { caps: null })).missing, null);
});

test('briefOf hides live values for offline devices and reports the tier', () => {
  const off = briefOf(row('OFF', { online: false }));
  assert.equal(off.tier, 'OFFLINE');
  assert.equal(off.batteryPct, null);
  assert.equal(off.hw, null);
  const on = briefOf(row('ON'));
  assert.equal(on.tier, 'READY');
  assert.equal(on.batteryPct, 90);
  assert.equal(on.hw?.touchDevs, 2);
});

test('an online device without hardware data still reaches the attention list', () => {
  const d = summarizeFleet(
    [
      row('OLD', { hw: null, caps: { ...FULL, a11y: false } }),
      row('OLD2', { hw: null, drops24h: 9 }),
      row('OLD3', { hw: null, volatile: { screenOn: true, charging: false, batteryPct: 8, net: 'wifi', rssi: -50 } }),
    ],
    NOW,
  );
  assert.deepEqual(d.lists.noHwData.sort(), ['OLD', 'OLD2', 'OLD3']);
  const ids = d.attention.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, ['OLD', 'OLD2', 'OLD3']);
});

test('prototype-looking keys are not lists', () => {
  const d = summarizeFleet([row('A')], NOW);
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(d.lists[k], undefined, k);
});

test('short or odd version strings compare sanely', () => {
  const d = summarizeFleet([row('A', { agentVer: '1' }), row('B', { agentVer: '1.9' }), row('C', { agentVer: 'abc' }), row('D', { agentVer: '1.2' })], NOW);
  assert.deepEqual(d.lists.outdated.sort(), ['A', 'C']);
});
