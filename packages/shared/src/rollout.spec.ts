import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashRow } from './dashboard';
import { healthProblems, isRolloutBucket, isValidVersion, summarizeRollout } from './rollout';

const NOW = 1_800_000_000_000;
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
    lastSessionMs: null,
    drops24h: 0,
    hwEvents24h: [],
    ...over,
  };
}

test('version and bucket validation', () => {
  assert.equal(isValidVersion('1.4.8'), true);
  for (const bad of ['1.4', '1.4.8-beta', 'x.y.z', '', '1.4.8.1', 12, null, '1.4.99999']) assert.equal(isValidVersion(bad), false, String(bad));
  assert.equal(isRolloutBucket('done'), true);
  for (const bad of ['__proto__', 'constructor', 'Done', '', 1]) assert.equal(isRolloutBucket(bad), false);
});

test('every device lands in exactly one bucket and the counts add up', () => {
  const rows = [
    row('DONE'),
    row('DONE_NEWER', { agentVer: '1.5.0' }),
    row('BROKEN', { caps: { ...FULL, a11y: false } }),
    row('GONE', { online: false }),
    row('STUCK', { agentVer: '1.4.3' }),
    row('SLEEPING', { agentVer: '1.4.3', online: false }),
    row('NOVER', { agentVer: null, caps: null }),
  ];
  const r = summarizeRollout(rows, '1.4.8', NOW);
  assert.equal(r.total, 7);
  assert.deepEqual(r.buckets.done.sort(), ['DONE', 'DONE_NEWER']);
  assert.deepEqual(r.buckets.updatedUnhealthy, ['BROKEN']);
  assert.deepEqual(r.buckets.updatedOffline, ['GONE']);
  assert.deepEqual(r.buckets.pendingOnline, ['STUCK']);
  assert.deepEqual(r.buckets.pendingOffline, ['SLEEPING']);
  assert.deepEqual(r.buckets.unknown, ['NOVER']);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.total);
  assert.equal(r.complete, false);
  assert.deepEqual(r.reasons.BROKEN, ['NO_ACCESSIBILITY']);
});

test('complete only when every device is updated, online and healthy', () => {
  assert.equal(summarizeRollout([row('A'), row('B')], '1.4.8', NOW).complete, true);
  assert.equal(summarizeRollout([row('A'), row('B', { online: false })], '1.4.8', NOW).complete, false);
  assert.equal(summarizeRollout([row('A'), row('B', { agentVer: '1.4.7' })], '1.4.8', NOW).complete, false);
  assert.equal(summarizeRollout([row('A'), row('B', { drops24h: 9 })], '1.4.8', NOW).complete, false);
  assert.equal(summarizeRollout([], '1.4.8', NOW).complete, false, 'an empty fleet is not "done"');
});

test('percent done counts only healthy updated devices', () => {
  const r = summarizeRollout([row('A'), row('B'), row('C', { online: false }), row('D', { agentVer: '1.4.0' })], '1.4.8', NOW);
  assert.equal(r.percentDone, 50);
});

test('health problems after an update are reported with a reason', () => {
  assert.deepEqual(healthProblems(row('OK')), []);
  assert.ok(healthProblems(row('X', { drops24h: 5 })).includes('FLAPPING'));
  assert.ok(healthProblems(row('X', { hw: { mainLagMs: 4000 } })).includes('LAG'));
  assert.ok(healthProblems(row('X', { hw: { display: 1 } })).includes('PANEL_OFF'));
  assert.ok(healthProblems(row('X', { hw: { touchDevs: 0 } })).includes('TOUCH_GONE'));
  assert.ok(healthProblems(row('X', { caps: { projectMedia: 'blocked', a11y: false, knox: 'unsupported', overlay: false, secureSettings: false } })).includes('NOT_READY'));
});

test('missing hardware data is a problem only for agents that should send it', () => {
  assert.ok(healthProblems(row('NEW', { hw: null, agentVer: '1.4.8' })).includes('NO_HW_DATA'));
  assert.ok(!healthProblems(row('OLD', { hw: null, agentVer: '1.4.3' })).includes('NO_HW_DATA'));
});

test('suggested target is the highest version in the fleet; version list is newest first', () => {
  const r = summarizeRollout([row('A', { agentVer: '1.4.3' }), row('B', { agentVer: '1.4.8' }), row('C', { agentVer: '1.4.8' }), row('D', { agentVer: '1.10.0' })], '1.4.8', NOW);
  assert.equal(r.suggestedTarget, '1.10.0');
  assert.deepEqual(r.versions.map((v) => v.version), ['1.10.0', '1.4.8', '1.4.3']);
});

test('buckets are plain arrays and reasons have no prototype keys', () => {
  const r = summarizeRollout([row('A')], '1.4.8', NOW);
  assert.equal(r.reasons['__proto__'], undefined);
  assert.equal(r.reasons['constructor'], undefined);
});
