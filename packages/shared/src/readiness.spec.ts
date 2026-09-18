import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeReadiness } from './readiness';
import { deepMerge } from './deep-merge';
import type { Caps, DeviceState, Volatile } from './types';

const base: DeviceState = {
  online: true,
  agentVer: '1.2.0',
  caps: {
    projectMedia: 'allow',
    a11y: true,
    knox: 'licensed',
    overlay: true,
    secureSettings: true,
  },
  volatile: { screenOn: true, charging: true, batteryPct: 90, net: 'wifi', rssi: -50 },
};

const cases: Array<[string, unknown, string, string[]]> = [
  ['all good', {}, 'READY', []],
  ['offline', { online: false }, 'OFFLINE', []],
  ['appop gone, a11y remains', { caps: { projectMedia: 'default' } }, 'DEGRADED', ['NEEDS_AUTOCLICK']],
  [
    'appop gone, a11y off',
    { caps: { projectMedia: 'default', a11y: false } },
    'NOT_READY',
    ['NO_CAPTURE_PATH'],
  ],
  ['knox gone, a11y remains', { caps: { knox: 'unsupported' } }, 'DEGRADED', ['GESTURE_INPUT_ONLY']],
  [
    'knox gone, a11y off',
    { caps: { knox: 'unsupported', a11y: false } },
    'NOT_READY',
    ['NO_INPUT_PATH'],
  ],
  [
    'appop gone, overlay gone',
    { caps: { projectMedia: 'default', overlay: false } },
    'NOT_READY',
    ['NO_BG_ACTIVITY_START'],
  ],
  ['outdated agent', { agentVer: '1.0.0' }, 'NOT_READY', ['AGENT_OUTDATED']],
  ['screen off', { volatile: { screenOn: false } }, 'DEGRADED', ['SCREEN_OFF']],
  [
    'low battery, not charging',
    { volatile: { batteryPct: 10, charging: false } },
    'DEGRADED',
    ['LOW_BATTERY'],
  ],
  ['weak 4G', { volatile: { net: 'cellular', rssi: -110 } }, 'DEGRADED', ['WEAK_SIGNAL']],
];

for (const [name, patch, tier, codes] of cases) {
  test(name, () => {
    const r = computeReadiness(deepMerge(base, patch));
    assert.equal(r.tier, tier);
    assert.deepEqual([...(r.blockers ?? []).map((b) => b.code), ...(r.warns ?? [])], codes);
  });
}

test('NOT_READY beats DEGRADED when capture is missing and battery is low', () => {
  const r = computeReadiness(
    deepMerge(base, {
      caps: { projectMedia: 'blocked', a11y: false } satisfies Partial<Caps>,
      volatile: { batteryPct: 10, charging: false } satisfies Partial<Volatile>,
    }),
  );
  assert.equal(r.tier, 'NOT_READY');
  assert.equal(r.blockers?.[0]?.code, 'NO_CAPTURE_PATH');
});
