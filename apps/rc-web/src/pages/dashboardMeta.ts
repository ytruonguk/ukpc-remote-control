/** Mỗi chỉ số của dashboard: tiêu đề, giải thích và các cột có ích khi xem danh sách máy đứng sau nó. */
export type Col =
  | 'status' | 'group' | 'lastSeen' | 'agent' | 'missing' | 'lag' | 'ram' | 'disk' | 'temp' | 'panel' | 'touch'
  | 'uiIdle' | 'battery' | 'net' | 'drops' | 'lastSession' | 'events' | 'reasons';

export type Meta = { title: string; note?: string; cols: Col[]; sort?: Col; desc?: boolean };

const STATUS_FIRST: Col[] = ['status', 'lastSeen', 'agent'];

export const METRICS: Record<string, Meta> = {
  online: { title: 'Connected devices', cols: ['status', 'lastSeen', 'agent', 'net', 'battery'] },
  offline: { title: 'Disconnected devices', note: 'Not sending heartbeats. Longest offline first.', cols: ['lastSeen', 'status', 'agent', 'drops'], sort: 'lastSeen' },
  offlineOver24h: { title: 'Offline for more than 24 h', cols: ['lastSeen', 'agent', 'drops'], sort: 'lastSeen' },
  neverSeen: { title: 'Never seen', note: 'Known to the MDM but never reported to the backend.', cols: ['group', 'agent'] },
  flapping: { title: 'Dropping connection', note: '5 or more connection drops in the last 24 h. Open a device to see the reasons.', cols: ['drops', 'status', 'lastSeen', 'agent'], sort: 'drops', desc: true },
  notReady: { title: 'Not ready for remote control', cols: ['status', 'missing', 'agent', 'lastSeen'] },
  permissionsComplete: { title: 'Devices with all permissions', cols: ['status', 'agent', 'lastSeen'] },
  permissionsIncomplete: { title: 'Devices missing permissions', note: 'Permissions can only be granted with ADB (pm grant / appops) when provisioning.', cols: ['missing', 'status', 'agent', 'lastSeen'] },
  permissionsUnknown: { title: 'Permissions not reported yet', cols: ['status', 'agent', 'lastSeen'] },
  missingSecureSettings: { title: 'Missing WRITE_SECURE_SETTINGS', note: 'The agent cannot re-enable its accessibility service by itself.', cols: ['missing', 'status', 'agent', 'lastSeen'] },
  missingA11y: { title: 'Accessibility service off', note: 'Input, screenshots and consent clicks fall back or stop working.', cols: ['missing', 'status', 'agent', 'lastSeen'] },
  missingOverlay: { title: 'Overlay permission missing', cols: ['missing', 'status', 'agent', 'lastSeen'] },
  lagging: { title: 'Lagging devices', note: 'Agent main-thread lag of 1.5 s or more. Worst first.', cols: ['lag', 'ram', 'status', 'events'], sort: 'lag', desc: true },
  hot: { title: 'Hot devices', note: 'Battery 47 °C or more, or thermal status 3+.', cols: ['temp', 'battery', 'status'], sort: 'temp', desc: true },
  lowMem: { title: 'Low RAM', note: 'Under 250 MB free.', cols: ['ram', 'lag', 'status'], sort: 'ram' },
  lowDisk: { title: 'Low disk space', note: 'Under 300 MB free.', cols: ['disk', 'status'], sort: 'disk' },
  panelOff: { title: 'Panel off while the system thinks the screen is on', cols: ['panel', 'touch', 'events', 'status'] },
  touchGone: { title: 'Touch controller lost', cols: ['touch', 'panel', 'events', 'status'] },
  noHwData: { title: 'No hardware data', note: 'Agent older than 1.4.7, or not reporting yet.', cols: ['agent', 'status', 'lastSeen'] },
  uiIdle6h: { title: 'UI static for 6 h or more', note: 'No change on the device screen. A kiosk page that never changes is static by design.', cols: ['uiIdle', 'lastSession', 'status'], sort: 'uiIdle', desc: true },
  uiIdle24h: { title: 'UI static for 24 h or more', note: 'No change on the device screen. A kiosk page that never changes is static by design.', cols: ['uiIdle', 'lastSession', 'status'], sort: 'uiIdle', desc: true },
  noSession7d: { title: 'No remote session in 7 days', cols: ['lastSession', 'lastSeen', 'status'], sort: 'lastSession' },
  lowBattery: { title: 'Low battery (unplugged)', cols: ['battery', 'net', 'status'], sort: 'battery' },
  notCharging: { title: 'Not charging', cols: ['battery', 'net', 'status'], sort: 'battery' },
  weakSignal: { title: 'Weak cellular signal', cols: ['net', 'battery', 'status'], sort: 'net' },
  wifi: { title: 'Wi-Fi devices', cols: ['net', 'battery', 'status'] },
  cellular: { title: 'Cellular devices', cols: ['net', 'battery', 'status'], sort: 'net' },
  ethernet: { title: 'Ethernet devices', cols: ['net', 'battery', 'status'] },
  outdated: { title: 'Agent below the minimum supported version', cols: ['agent', 'status', 'lastSeen'] },
  'tier:READY': { title: 'Ready', cols: STATUS_FIRST },
  'tier:DEGRADED': { title: 'Degraded', note: 'Usable, with warnings (screen off, low battery, gesture input only…).', cols: STATUS_FIRST },
  'tier:NOT_READY': { title: 'Not ready', cols: ['status', 'missing', 'agent', 'lastSeen'] },
  'tier:OFFLINE': { title: 'Offline', cols: ['lastSeen', 'status', 'agent'], sort: 'lastSeen' },
};

export const REASON_LABEL: Record<string, string> = {
  NOT_READY: 'not ready',
  PANEL_OFF: 'panel off',
  TOUCH_GONE: 'touch gone',
  LAG: 'lag',
  HOT: 'hot',
  LOW_MEM: 'low RAM',
  LOW_DISK: 'low disk',
  FLAPPING: 'dropping connection',
  MISSING_PERMISSIONS: 'missing permissions',
  LOW_BATTERY: 'low battery',
  OFFLINE_OVER_24H: 'offline > 24 h',
  NO_ACCESSIBILITY: 'accessibility off',
  NO_HW_DATA: 'no hardware data',
};

export const ROLLOUT_TEXT: Record<string, { title: string; note: string; cols: Col[] }> = {
  done: { title: 'Updated, online and healthy', note: 'These devices need nothing more.', cols: ['agent', 'status', 'lastSeen'] },
  updatedUnhealthy: { title: 'Updated but unhealthy', note: 'On the target version, but something is wrong. Open a device to see its hardware and connection history.', cols: ['reasons', 'agent', 'status', 'lastSeen'] },
  updatedOffline: { title: 'Updated, now offline', note: 'Reported the new version and then went quiet. This may be the update breaking the agent: check these first.', cols: ['lastSeen', 'agent', 'drops'] },
  pendingOnline: { title: 'Online, not updated yet', note: 'Connected but still on an older version. Check the install state in the MDM (storage, policy, sync).', cols: ['agent', 'status', 'lastSeen'] },
  pendingOffline: { title: 'Offline, not updated', note: 'Cannot update until it reconnects. Longest offline first.', cols: ['lastSeen', 'agent', 'drops'] },
  unknown: { title: 'No version reported', note: 'Known to the MDM but never reported to the backend.', cols: ['agent', 'lastSeen'] },
};

export function metaFor(key: string): Meta {
  const ro = /^rollout:([A-Za-z]+):(\d+\.\d+\.\d+)$/.exec(key);
  if (ro && Object.hasOwn(ROLLOUT_TEXT, ro[1])) {
    const t = ROLLOUT_TEXT[ro[1]];
    return { title: `${t.title} (target ${ro[2]})`, note: t.note, cols: t.cols, sort: ro[1].endsWith('Offline') ? 'lastSeen' : undefined };
  }
  // hasOwn: khoá như `__proto__`/`constructor` không được lọt vào bảng tra cứu qua prototype.
  if (Object.hasOwn(METRICS, key)) return METRICS[key];
  if (key.startsWith('ver:')) return { title: `Agent version ${key.slice(4)}`, cols: ['status', 'lastSeen', 'group'] };
  return { title: key, cols: STATUS_FIRST };
}

export const MISSING_LABEL: Record<string, string> = {
  secureSettings: 'WRITE_SECURE_SETTINGS',
  a11y: 'Accessibility',
  overlay: 'Overlay',
};

export const DISPLAY_LABEL: Record<number, string> = { 1: 'OFF', 2: 'ON', 3: 'DOZE', 4: 'DOZE_SUSPEND', 5: 'VR', 6: 'ON_SUSPEND' };

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
