import { computeReadiness } from './readiness';
import { semverLt } from './semver';
import { MIN_AGENT_VER, type Caps, type DeviceState, type HwVolatile, type Tier, type Volatile } from './types';

/** Ngưỡng tính "lag / nóng / thiếu RAM"... cho dashboard. Khớp ngưỡng cảnh báo phía agent (HwAnomaly). */
export const DASH_LIMITS = {
  lagMs: 1500,
  hotBattC: 47,
  hotThermal: 3,
  lowMemMb: 250,
  lowDiskMb: 300,
  lowBatteryPct: 20,
  weakRssi: -100,
  /** uiIdleMs: thời gian không có sự kiện giao diện (accessibility). Màn kiosk tĩnh vốn đứng yên, nên chỉ là tín hiệu phụ. */
  idleLongMs: 6 * 3_600_000,
  idleVeryLongMs: 24 * 3_600_000,
  offlineLongMs: 24 * 3_600_000,
  noSessionMs: 7 * 24 * 3_600_000,
  flappingDrops: 5,
} as const;

export interface DashRow {
  deviceId: string;
  label: string | null;
  group: string | null;
  online: boolean;
  lastSeenMs: number | null;
  agentVer: string | null;
  /** null = máy chưa từng báo caps. */
  caps: Caps | null;
  needsReprovisioning: boolean;
  volatile: Partial<Volatile>;
  hw: HwVolatile | null;
  /** Lần mở phiên remote gần nhất (null = chưa từng). */
  lastSessionMs: number | null;
  /** Số lần broker báo ngắt trong 24 giờ qua. */
  drops24h: number;
  /** Các mã event HW_* trong 24 giờ qua. */
  hwEvents24h: string[];
}

export interface AttentionItem {
  deviceId: string;
  label: string | null;
  group: string | null;
  score: number;
  reasons: string[];
}

export interface Dashboard {
  generatedAt: number;
  total: number;
  connectivity: { online: number; offline: number; offlineOver24h: number; neverSeen: number };
  tiers: Record<Tier, number>;
  permissions: { complete: number; incomplete: number; unknown: number; missingSecureSettings: number; missingA11y: number; missingOverlay: number };
  performance: { lagging: number; hot: number; lowMem: number; lowDisk: number; panelOff: number; touchGone: number; noHwData: number };
  interaction: { uiIdle6h: number; uiIdle24h: number; noSession7d: number };
  battery: { low: number; notCharging: number };
  network: { wifi: number; cellular: number; ethernet: number; unknown: number; weakSignal: number };
  versions: { version: string; count: number }[];
  outdated: number;
  stability: { flapping: number; drops24h: number };
  events24h: { code: string; devices: number }[];
  /** Mỗi chỉ số → danh sách deviceId, để bấm vào xem máy nào. */
  lists: Record<string, string[]>;
  attention: AttentionItem[];
}

const WEIGHT: Record<string, number> = {
  NOT_READY: 5,
  PANEL_OFF: 5,
  TOUCH_GONE: 5,
  LAG: 3,
  HOT: 3,
  LOW_MEM: 2,
  LOW_DISK: 2,
  FLAPPING: 3,
  MISSING_PERMISSIONS: 2,
  LOW_BATTERY: 1,
  OFFLINE_OVER_24H: 1,
};

function toState(r: DashRow): DeviceState {
  const caps: Caps = r.caps ?? { projectMedia: 'blocked', a11y: false, knox: 'unsupported', overlay: false, secureSettings: false };
  return {
    online: r.online,
    agentVer: r.agentVer ?? '0.0.0',
    caps,
    volatile: {
      screenOn: r.volatile.screenOn ?? false,
      charging: r.volatile.charging ?? false,
      batteryPct: r.volatile.batteryPct ?? 0,
      net: r.volatile.net ?? 'unknown',
      rssi: r.volatile.rssi ?? 0,
    },
    needsReprovisioning: r.needsReprovisioning,
  };
}

/** Gom số liệu cho cả fleet. Hàm thuần: `now` truyền vào để test. Máy `stale` (đã gỡ khỏi MDM) do người gọi loại trước. */
export function summarizeFleet(rows: DashRow[], now: number, maxAttention = 30): Dashboard {
  const L = DASH_LIMITS;
  // Không có prototype: khoá do người dùng gửi lên (`__proto__`, `constructor`) không được trả về thứ gì khác ngoài mảng của mình.
  const lists: Record<string, string[]> = Object.create(null);
  const add = (key: string, id: string) => (lists[key] ??= []).push(id);
  const tiers: Record<Tier, number> = { READY: 0, DEGRADED: 0, NOT_READY: 0, OFFLINE: 0 };
  const net = { wifi: 0, cellular: 0, ethernet: 0, unknown: 0, weakSignal: 0 };
  const versions = new Map<string, number>();
  const eventDevices = new Map<string, number>();
  const attention: AttentionItem[] = [];
  let drops24h = 0;
  let neverSeen = 0;

  for (const r of rows) {
    const reasons: string[] = [];
    const flag = (code: string, key?: string) => {
      reasons.push(code);
      if (key) add(key, r.deviceId);
    };

    const tier = computeReadiness(toState(r)).tier;
    tiers[tier]++;
    add(`tier:${tier}`, r.deviceId);

    // --- kết nối
    if (r.online) add('online', r.deviceId);
    else {
      add('offline', r.deviceId);
      if (r.lastSeenMs === null) {
        neverSeen++;
        add('neverSeen', r.deviceId);
      }
      else if (now - r.lastSeenMs > L.offlineLongMs) {
        add('offlineOver24h', r.deviceId);
        reasons.push('OFFLINE_OVER_24H');
      }
    }
    if (tier === 'NOT_READY') flag('NOT_READY', 'notReady');

    // --- quyền
    if (!r.caps) add('permissionsUnknown', r.deviceId);
    else {
      const miss = [!r.caps.secureSettings && 'missingSecureSettings', !r.caps.a11y && 'missingA11y', !r.caps.overlay && 'missingOverlay'].filter(Boolean) as string[];
      if (miss.length) {
        add('permissionsIncomplete', r.deviceId);
        for (const m of miss) add(m, r.deviceId);
        reasons.push('MISSING_PERMISSIONS');
      } else add('permissionsComplete', r.deviceId);
    }

    // --- phiên bản
    const ver = r.agentVer ?? 'unknown';
    versions.set(ver, (versions.get(ver) ?? 0) + 1);
    add(`ver:${ver}`, r.deviceId);
    if (r.agentVer && semverLt(r.agentVer, MIN_AGENT_VER)) add('outdated', r.deviceId);

    // --- ổn định kết nối
    drops24h += r.drops24h;
    if (r.drops24h >= L.flappingDrops) flag('FLAPPING', 'flapping');
    for (const code of new Set(r.hwEvents24h)) eventDevices.set(code, (eventDevices.get(code) ?? 0) + 1);

    // --- tương tác (không phụ thuộc đang online)
    if (r.lastSessionMs === null || now - r.lastSessionMs > L.noSessionMs) add('noSession7d', r.deviceId);

    if (!r.online) continue;

    // --- mạng, pin
    const n = r.volatile.net ?? 'unknown';
    if (n === 'wifi' || n === 'cellular' || n === 'ethernet') {
      net[n]++;
      add(n, r.deviceId);
    } else net.unknown++;
    if (n === 'cellular' && (r.volatile.rssi ?? 0) !== 0 && (r.volatile.rssi ?? 0) < L.weakRssi) {
      net.weakSignal++;
      add('weakSignal', r.deviceId);
    }
    if (!r.volatile.charging) {
      add('notCharging', r.deviceId);
      if ((r.volatile.batteryPct ?? 100) < L.lowBatteryPct) flag('LOW_BATTERY', 'lowBattery');
    }

    // --- phần cứng (chỉ máy online và có agent 1.4.7+)
    const hw = r.hw;
    if (!hw) add('noHwData', r.deviceId);
    else {
      if ((hw.mainLagMs ?? 0) >= L.lagMs) flag('LAG', 'lagging');
      if ((hw.battTempC ?? 0) >= L.hotBattC || (hw.thermal ?? 0) >= L.hotThermal) flag('HOT', 'hot');
      if (hw.memAvailMb !== undefined && hw.memAvailMb < L.lowMemMb) flag('LOW_MEM', 'lowMem');
      if (hw.diskFreeMb !== undefined && hw.diskFreeMb < L.lowDiskMb) flag('LOW_DISK', 'lowDisk');
      // Hệ thống tưởng màn hình sáng nhưng panel không ở trạng thái ON (1 OFF, 3 DOZE, 4 DOZE_SUSPEND).
      if (r.volatile.screenOn && hw.display !== undefined && [1, 3, 4].includes(hw.display)) flag('PANEL_OFF', 'panelOff');
      if (hw.touchDevs === 0) flag('TOUCH_GONE', 'touchGone');
      if (hw.uiIdleMs !== undefined && hw.uiIdleMs >= L.idleVeryLongMs) {
        add('uiIdle24h', r.deviceId);
        add('uiIdle6h', r.deviceId);
      } else if (hw.uiIdleMs !== undefined && hw.uiIdleMs >= L.idleLongMs) add('uiIdle6h', r.deviceId);
    }

    const score = reasons.reduce((s, c) => s + (WEIGHT[c] ?? 1), 0);
    if (score > 0) attention.push({ deviceId: r.deviceId, label: r.label, group: r.group, score, reasons });
  }

  // Máy offline cũng có thể đáng chú ý (NOT_READY, mất quyền) nên chấm điểm riêng cho nhóm còn lại.
  const scored = new Set(attention.map((a) => a.deviceId));
  for (const r of rows) {
    if (r.online || scored.has(r.deviceId)) continue;
    const reasons: string[] = [];
    if (r.drops24h >= L.flappingDrops) reasons.push('FLAPPING');
    if (r.lastSeenMs !== null && now - r.lastSeenMs > L.offlineLongMs) reasons.push('OFFLINE_OVER_24H');
    if (r.caps && (!r.caps.a11y || !r.caps.overlay || !r.caps.secureSettings)) reasons.push('MISSING_PERMISSIONS');
    const score = reasons.reduce((s, c) => s + (WEIGHT[c] ?? 1), 0);
    if (score > 0) attention.push({ deviceId: r.deviceId, label: r.label, group: r.group, score, reasons });
  }
  attention.sort((a, b) => b.score - a.score || a.deviceId.localeCompare(b.deviceId));

  const len = (k: string) => lists[k]?.length ?? 0;
  const withCaps = rows.filter((r) => r.caps).length;
  return {
    generatedAt: now,
    total: rows.length,
    connectivity: { online: len('online'), offline: len('offline'), offlineOver24h: len('offlineOver24h'), neverSeen },
    tiers,
    permissions: {
      complete: len('permissionsComplete'),
      incomplete: len('permissionsIncomplete'),
      unknown: rows.length - withCaps,
      missingSecureSettings: len('missingSecureSettings'),
      missingA11y: len('missingA11y'),
      missingOverlay: len('missingOverlay'),
    },
    performance: {
      lagging: len('lagging'),
      hot: len('hot'),
      lowMem: len('lowMem'),
      lowDisk: len('lowDisk'),
      panelOff: len('panelOff'),
      touchGone: len('touchGone'),
      noHwData: len('noHwData'),
    },
    interaction: { uiIdle6h: len('uiIdle6h'), uiIdle24h: len('uiIdle24h'), noSession7d: len('noSession7d') },
    battery: { low: len('lowBattery'), notCharging: len('notCharging') },
    network: net,
    versions: [...versions.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    outdated: len('outdated'),
    stability: { flapping: len('flapping'), drops24h },
    events24h: [...eventDevices.entries()].map(([code, devices]) => ({ code, devices })).sort((a, b) => b.devices - a.devices),
    lists,
    attention: attention.slice(0, maxAttention),
  };
}

export interface DeviceBrief {
  deviceId: string;
  label: string | null;
  group: string | null;
  online: boolean;
  tier: Tier;
  lastSeenMs: number | null;
  agentVer: string | null;
  /** Quyền còn thiếu: 'secureSettings' | 'a11y' | 'overlay' (rỗng = đủ; null = máy chưa báo). */
  missing: string[] | null;
  drops24h: number;
  lastSessionMs: number | null;
  batteryPct: number | null;
  charging: boolean | null;
  net: string | null;
  rssi: number | null;
  hw: HwVolatile | null;
  hwEvents24h: string[];
}

/** Một dòng chi tiết cho trang danh sách khi bấm vào một chỉ số trên dashboard. */
export function briefOf(r: DashRow): DeviceBrief {
  const c = r.caps;
  return {
    deviceId: r.deviceId,
    label: r.label,
    group: r.group,
    online: r.online,
    tier: computeReadiness(toState(r)).tier,
    lastSeenMs: r.lastSeenMs,
    agentVer: r.agentVer,
    missing: c ? [!c.secureSettings && 'secureSettings', !c.a11y && 'a11y', !c.overlay && 'overlay'].filter(Boolean) as string[] : null,
    drops24h: r.drops24h,
    lastSessionMs: r.lastSessionMs,
    batteryPct: r.online ? (r.volatile.batteryPct ?? null) : null,
    charging: r.online ? (r.volatile.charging ?? null) : null,
    net: r.online ? (r.volatile.net ?? null) : null,
    rssi: r.online ? (r.volatile.rssi ?? null) : null,
    hw: r.online ? r.hw : null,
    hwEvents24h: [...new Set(r.hwEvents24h)],
  };
}
