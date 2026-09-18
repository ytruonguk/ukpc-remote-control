import { MIN_AGENT_VER, type Blocker, type DeviceState, type Readiness } from './types';
import { semverLt } from './semver';

export function computeReadiness(d: DeviceState): Readiness {
  if (!d.online) return { tier: 'OFFLINE' };

  const blockers: Blocker[] = [];

  if (d.caps.projectMedia !== 'allow' && !d.caps.a11y)
    blockers.push({ code: 'NO_CAPTURE_PATH', fix: 'reprovision' });

  if (d.caps.knox !== 'licensed' && !d.caps.a11y)
    blockers.push({ code: 'NO_INPUT_PATH', fix: 'selfheal' });

  if (d.caps.projectMedia !== 'allow' && !d.caps.overlay)
    blockers.push({ code: 'NO_BG_ACTIVITY_START', fix: 'reprovision' });

  if (semverLt(d.agentVer, MIN_AGENT_VER))
    blockers.push({ code: 'AGENT_OUTDATED', fix: 'update' });

  if (blockers.length) return { tier: 'NOT_READY', blockers };

  const warns: string[] = [];
  if (d.caps.projectMedia !== 'allow') warns.push('NEEDS_AUTOCLICK');
  if (!d.volatile.screenOn) warns.push('SCREEN_OFF');
  if (d.caps.knox !== 'licensed') warns.push('GESTURE_INPUT_ONLY');
  if (!d.volatile.charging && d.volatile.batteryPct < 20) warns.push('LOW_BATTERY');
  if (d.volatile.net === 'cellular' && d.volatile.rssi < -100) warns.push('WEAK_SIGNAL');

  return warns.length ? { tier: 'DEGRADED', warns } : { tier: 'READY' };
}
