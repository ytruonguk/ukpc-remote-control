import type { StateMsg } from './types';

export function liveHashPatch(msg: StateMsg): Record<string, string> {
  const volatile = msg.volatile ?? {};
  const patch: Record<string, string> = {
    ts: String(msg.ts),
    screenOn: volatile.screenOn ? '1' : '0',
    charging: volatile.charging ? '1' : '0',
    batteryPct: String(volatile.batteryPct ?? 0),
    net: volatile.net ?? '',
    rssi: String(volatile.rssi ?? 0),
  };
  if (typeof msg.online === 'boolean') patch.online = msg.online ? '1' : '0';
  return patch;
}
