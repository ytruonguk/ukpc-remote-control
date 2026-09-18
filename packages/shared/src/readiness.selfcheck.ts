import { computeReadiness } from './readiness';
import type { DeviceState } from './types';
import assert from 'node:assert/strict';

const ready: DeviceState = {
  online: true,
  agentVer: '1.2.0',
  caps: {
    projectMedia: 'allow',
    a11y: true,
    knox: 'licensed',
    overlay: true,
    secureSettings: true,
  },
  volatile: { screenOn: true, charging: true, batteryPct: 80, net: 'wifi', rssi: -50 },
};

assert.equal(computeReadiness(ready).tier, 'READY');
assert.equal(computeReadiness({ ...ready, online: false }).tier, 'OFFLINE');
assert.equal(
  computeReadiness({
    ...ready,
    caps: { ...ready.caps, projectMedia: 'blocked', a11y: false },
  }).tier,
  'NOT_READY',
);
assert.equal(
  computeReadiness({
    ...ready,
    volatile: { ...ready.volatile, screenOn: false },
  }).tier,
  'DEGRADED',
);

console.log('readiness.selfcheck ok');
