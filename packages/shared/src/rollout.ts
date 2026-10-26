import { computeReadiness } from './readiness';
import { semverLt } from './semver';
import { DASH_LIMITS, type DashRow } from './dashboard';
import type { Caps, DeviceState } from './types';

/**
 * Theo dõi một đợt cập nhật agent: mỗi máy rơi vào đúng MỘT nhóm. "Xong" chỉ khi cả fleet ở nhóm `done`,
 * nghĩa là đã đúng phiên bản VÀ đang online VÀ khỏe — không chỉ "đã báo phiên bản mới".
 */
export type RolloutBucket = 'done' | 'updatedUnhealthy' | 'updatedOffline' | 'pendingOnline' | 'pendingOffline' | 'unknown';

export const ROLLOUT_BUCKETS: readonly RolloutBucket[] = ['done', 'updatedUnhealthy', 'updatedOffline', 'pendingOnline', 'pendingOffline', 'unknown'];

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** Từ bản này agent mới gửi chỉ số phần cứng; thiếu chúng sau khi lên bản này nghĩa là monitor không chạy. */
const HW_SINCE = '1.4.7';

export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

export function isRolloutBucket(v: unknown): v is RolloutBucket {
  return typeof v === 'string' && (ROLLOUT_BUCKETS as readonly string[]).includes(v);
}

export interface Rollout {
  target: string;
  /** Phiên bản cao nhất đang chạy trong fleet: gợi ý mặc định khi người dùng chưa chọn. */
  suggestedTarget: string | null;
  generatedAt: number;
  total: number;
  counts: Record<RolloutBucket, number>;
  percentDone: number;
  complete: boolean;
  versions: { version: string; count: number }[];
  buckets: Record<RolloutBucket, string[]>;
  /** deviceId → lý do (chỉ máy ở nhóm `updatedUnhealthy`). */
  reasons: Record<string, string[]>;
}

function atOrAbove(ver: string, target: string): boolean {
  return !semverLt(ver, target);
}

function stateOf(r: DashRow): DeviceState {
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

/** Những dấu hiệu cho thấy bản cập nhật làm hỏng thứ gì đó (hoặc máy đã hỏng sẵn). Rỗng = khỏe. */
export function healthProblems(r: DashRow): string[] {
  const out: string[] = [];
  if (computeReadiness(stateOf(r)).tier === 'NOT_READY') out.push('NOT_READY');
  if (r.caps && !r.caps.a11y) out.push('NO_ACCESSIBILITY');
  if (r.drops24h >= DASH_LIMITS.flappingDrops) out.push('FLAPPING');
  const hw = r.hw;
  if (!hw) {
    if (r.agentVer && atOrAbove(r.agentVer, HW_SINCE)) out.push('NO_HW_DATA');
  } else {
    if ((hw.mainLagMs ?? 0) >= DASH_LIMITS.lagMs) out.push('LAG');
    if (r.volatile.screenOn && hw.display !== undefined && [1, 3, 4].includes(hw.display)) out.push('PANEL_OFF');
    if (hw.touchDevs === 0) out.push('TOUCH_GONE');
  }
  return out;
}

export function summarizeRollout(rows: DashRow[], target: string, now: number): Rollout {
  const buckets = Object.fromEntries(ROLLOUT_BUCKETS.map((b) => [b, [] as string[]])) as Record<RolloutBucket, string[]>;
  const reasons: Record<string, string[]> = Object.create(null);
  const versions = new Map<string, number>();
  let suggested: string | null = null;

  for (const r of rows) {
    const ver = r.agentVer;
    if (ver) {
      versions.set(ver, (versions.get(ver) ?? 0) + 1);
      if (suggested === null || semverLt(suggested, ver)) suggested = ver;
    }
    let bucket: RolloutBucket;
    if (!ver) bucket = 'unknown';
    else if (atOrAbove(ver, target)) {
      if (!r.online) bucket = 'updatedOffline';
      else {
        const problems = healthProblems(r);
        if (problems.length) {
          bucket = 'updatedUnhealthy';
          reasons[r.deviceId] = problems;
        } else bucket = 'done';
      }
    } else bucket = r.online ? 'pendingOnline' : 'pendingOffline';
    buckets[bucket].push(r.deviceId);
  }

  const counts = Object.fromEntries(ROLLOUT_BUCKETS.map((b) => [b, buckets[b].length])) as Record<RolloutBucket, number>;
  const total = rows.length;
  return {
    target,
    suggestedTarget: suggested,
    generatedAt: now,
    total,
    counts,
    percentDone: total ? Math.floor((counts.done / total) * 1000) / 10 : 0,
    complete: total > 0 && counts.done === total,
    versions: [...versions.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => (semverLt(a.version, b.version) ? 1 : -1)),
    buckets,
    reasons,
  };
}
