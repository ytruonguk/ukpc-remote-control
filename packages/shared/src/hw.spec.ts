import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hwFromHash, hwLivePatch, isHwEventCode, normalizeHwSample, volatileHasHw } from './hw';

test('isHwEventCode accepts only known HW_ codes', () => {
  assert.equal(isHwEventCode('HW_PANEL_OFF'), true);
  assert.equal(isHwEventCode('PANEL_OFF'), false);
  assert.equal(isHwEventCode('H264_INIT'), false);
  assert.equal(isHwEventCode(42), false);
});

test('normalizeHwSample keeps known typed fields and drops junk', () => {
  const s = normalizeHwSample({
    ts: 1793007268792,
    phase: 'IDLE',
    memAvailMb: 1474,
    gpuPct: null,
    lowMem: false,
    anomaly: ['PANEL_OFF', 5, 'X'.repeat(500)],
    evil: 'drop me',
    thermal: 'hot',
    battTempC: Number.NaN,
  });
  assert.ok(s);
  assert.equal(s.ts, 1793007268792);
  assert.equal(s.memAvailMb, 1474);
  assert.equal(s.gpuPct, null);
  assert.equal(s.lowMem, false);
  assert.equal('evil' in s, false);
  assert.equal('thermal' in s, false);
  assert.equal('battTempC' in s, false);
  const a = s.anomaly as string[];
  assert.equal(a.length, 2);
  assert.equal(a[1].length, 128);
});

test('normalizeHwSample rejects missing or bad ts', () => {
  assert.equal(normalizeHwSample({ memAvailMb: 1 }), null);
  assert.equal(normalizeHwSample({ ts: 0 }), null);
  assert.equal(normalizeHwSample({ ts: 'now' }), null);
  assert.equal(normalizeHwSample(null), null);
});

test('hwLivePatch is empty for agents without hw fields', () => {
  assert.equal(volatileHasHw({ batteryPct: 80 }), false);
  assert.deepEqual(hwLivePatch({}), { set: {}, del: [] });
  assert.deepEqual(hwLivePatch(undefined), { set: {}, del: [] });
});

test('hwLivePatch sets present fields and deletes vanished optional ones', () => {
  const p = hwLivePatch({ thermal: 0, memAvailMb: 900, diskFreeMb: 4000, display: 2, touchDevs: 2, mainLagMs: 3, uiIdleMs: -1 });
  assert.equal(p.set.hw_memAvailMb, '900');
  assert.equal('hw_uiIdleMs' in p.set, false, '-1 means unknown, not a value');
  assert.deepEqual(p.del.sort(), ['hw_battTempC', 'hw_cpuPct', 'hw_fgPkg', 'hw_gpuPct', 'hw_uiIdleMs']);
  const q = hwLivePatch({ memAvailMb: 1, battTempC: 25.5, fgPkg: 'com.kiosk' });
  assert.equal(q.set.hw_battTempC, '25.5');
  assert.equal(q.set.hw_fgPkg, 'com.kiosk');
  assert.equal(q.del.includes('hw_battTempC'), false);
});

test('hwFromHash round-trips and is null when never reported', () => {
  assert.equal(hwFromHash({ batteryPct: '80' }), null);
  const p = hwLivePatch({ memAvailMb: 900, touchDevs: 0, fgPkg: 'com.kiosk' });
  assert.deepEqual(hwFromHash(p.set), { memAvailMb: 900, touchDevs: 0, fgPkg: 'com.kiosk' });
});

test('hwLivePatch clears every vanished field, not just optional ones', () => {
  const p = hwLivePatch({ memAvailMb: 500 });
  assert.deepEqual(p.set, { hw_memAvailMb: '500' });
  assert.ok(p.del.includes('hw_touchDevs'));
  assert.ok(p.del.includes('hw_display'));
  assert.equal(p.del.includes('hw_memAvailMb'), false);
});

test('unreadable sentinels are treated as absent', () => {
  const p = hwLivePatch({ thermal: -1, touchDevs: -1, diskFreeMb: -1, display: 0, memAvailMb: 1 });
  assert.deepEqual(Object.keys(p.set).sort(), ['hw_memAvailMb']);
  assert.ok(['hw_thermal', 'hw_touchDevs', 'hw_diskFreeMb', 'hw_display'].every((k) => p.del.includes(k)));
  // a genuine "no touch devices" is 0 and must be kept
  assert.equal(hwLivePatch({ touchDevs: 0 }).set.hw_touchDevs, '0');
});

test('normalizeHwSample strips NUL bytes that Postgres jsonb rejects', () => {
  const s = normalizeHwSample({ ts: 1793007268792, fgPkg: 'a\u0000b', anomaly: ['X\u0000Y'] });
  assert.ok(s);
  assert.equal(s.fgPkg, 'ab');
  assert.deepEqual(s.anomaly, ['XY']);
});
