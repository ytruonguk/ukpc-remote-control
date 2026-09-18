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
  ['tất cả tốt', {}, 'READY', []],
  ['offline', { online: false }, 'OFFLINE', []],
  ['appop mất, còn a11y', { caps: { projectMedia: 'default' } }, 'DEGRADED', ['NEEDS_AUTOCLICK']],
  [
    'appop mất, a11y tắt',
    { caps: { projectMedia: 'default', a11y: false } },
    'NOT_READY',
    ['NO_CAPTURE_PATH'],
  ],
  ['knox mất, còn a11y', { caps: { knox: 'unsupported' } }, 'DEGRADED', ['GESTURE_INPUT_ONLY']],
  [
    'knox mất, a11y tắt',
    { caps: { knox: 'unsupported', a11y: false } },
    'NOT_READY',
    ['NO_INPUT_PATH'],
  ],
  [
    'appop mất, overlay mất',
    { caps: { projectMedia: 'default', overlay: false } },
    'NOT_READY',
    ['NO_BG_ACTIVITY_START'],
  ],
  ['agent cũ', { agentVer: '1.0.0' }, 'NOT_READY', ['AGENT_OUTDATED']],
  ['màn hình tắt', { volatile: { screenOn: false } }, 'DEGRADED', ['SCREEN_OFF']],
  [
    'pin yếu không sạc',
    { volatile: { batteryPct: 10, charging: false } },
    'DEGRADED',
    ['LOW_BATTERY'],
  ],
  ['4G yếu', { volatile: { net: 'cellular', rssi: -110 } }, 'DEGRADED', ['WEAK_SIGNAL']],
];

for (const [name, patch, tier, codes] of cases) {
  test(name, () => {
    const r = computeReadiness(deepMerge(base, patch));
    assert.equal(r.tier, tier);
    assert.deepEqual([...(r.blockers ?? []).map((b) => b.code), ...(r.warns ?? [])], codes);
  });
}

test('NOT_READY thắng DEGRADED khi vừa thiếu capture vừa pin yếu', () => {
  const r = computeReadiness(
    deepMerge(base, {
      caps: { projectMedia: 'blocked', a11y: false } satisfies Partial<Caps>,
      volatile: { batteryPct: 10, charging: false } satisfies Partial<Volatile>,
    }),
  );
  assert.equal(r.tier, 'NOT_READY');
  assert.equal(r.blockers?.[0]?.code, 'NO_CAPTURE_PATH');
});
