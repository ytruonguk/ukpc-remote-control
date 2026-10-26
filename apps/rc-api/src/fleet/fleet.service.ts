import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CONN_REASON_HINT, briefOf, computeReadiness, hwFromHash, isRolloutBucket, isValidVersion, keys, summarizeFleet, summarizeRollout, type DashRow, type Caps, type DeviceState, type Volatile } from '@rc/shared';
import { PgService, RedisService } from '../infra/infra.module';

const KNOWN_LIST_KEYS = new Set([
  'online', 'offline', 'offlineOver24h', 'neverSeen', 'notReady', 'flapping',
  'permissionsComplete', 'permissionsIncomplete', 'permissionsUnknown', 'missingSecureSettings', 'missingA11y', 'missingOverlay',
  'lagging', 'hot', 'lowMem', 'lowDisk', 'panelOff', 'touchGone', 'noHwData',
  'uiIdle6h', 'uiIdle24h', 'noSession7d', 'lowBattery', 'notCharging', 'weakSignal', 'wifi', 'cellular', 'ethernet', 'outdated',
  'tier:READY', 'tier:DEGRADED', 'tier:NOT_READY', 'tier:OFFLINE',
]);

@Injectable()
export class FleetService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Tổng quan cả fleet cho dashboard. 150 máy → vài truy vấn nhỏ + một pipeline Redis, nên tính tại chỗ mỗi lần gọi
   * (giao diện làm mới 15 giây một lần). Chỉ gồm máy operator có quyền xem và chưa bị gỡ khỏi MDM.
   */
  private async loadDashRows(operatorId: number): Promise<{ rows: DashRow[]; now: number }> {
    const now = Date.now();
    const access = `(
      EXISTS (SELECT 1 FROM operator_group_access a WHERE a.operator_id = $1 AND a.group_id = d.group_id)
      OR EXISTS (SELECT 1 FROM operators WHERE id = $1 AND role IN ('admin', 'mdm_user') AND active = true)
    )`;
    const { rows } = await this.pg.pool.query<{
      device_id: string;
      label: string | null;
      group_name: string | null;
      last_seen: Date | null;
      needs_reprovisioning: boolean;
      agent_ver: string | null;
      project_media: string | null;
      a11y: boolean | null;
      knox: string | null;
      overlay: boolean | null;
      secure_settings: boolean | null;
    }>(
      `SELECT d.device_id, d.label, g.name AS group_name, d.last_seen, d.needs_reprovisioning,
              c.agent_ver, c.project_media, c.a11y, c.knox, c.overlay, c.secure_settings
       FROM devices d
       LEFT JOIN device_groups g ON g.id = d.group_id
       LEFT JOIN device_capabilities c ON c.device_id = d.device_id
       WHERE d.stale = false AND ${access}`,
      [operatorId],
    );
    const ids = rows.map((r) => r.device_id);

    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(keys.device(id));
    const live = (await pipe.exec()) ?? [];

    const [sessions, drops, events] = await Promise.all([
      this.pg.pool.query<{ device_id: string; at: Date }>(
      `SELECT device_id, max(requested_at) AS at FROM sessions WHERE device_id = ANY($1::text[]) GROUP BY device_id`,
      [ids],
      ),
      this.pg.pool.query<{ device_id: string; n: number }>(
      `SELECT device_id, count(*)::int AS n FROM device_conn_events
       WHERE source = 'broker' AND event = 'disconnected' AND at >= now() - interval '24 hours'
         AND device_id = ANY($1::text[]) GROUP BY device_id`,
      [ids],
      ),
      this.pg.pool.query<{ device_id: string; codes: string[] }>(
      `SELECT device_id, array_agg(DISTINCT code) AS codes FROM device_hw_events
       WHERE at >= now() - interval '24 hours' AND device_id = ANY($1::text[]) GROUP BY device_id`,
      [ids],
      ),
    ]);
    const lastSession = new Map(sessions.rows.map((r) => [r.device_id, r.at.getTime()]));
    const dropCount = new Map(drops.rows.map((r) => [r.device_id, r.n]));
    const hwEvents = new Map(events.rows.map((r) => [r.device_id, r.codes]));

    const dash: DashRow[] = rows.map((r, i) => {
      const hash = (live[i]?.[1] as Record<string, string>) ?? {};
      const hasCaps = r.agent_ver !== null;
      return {
        deviceId: r.device_id,
        label: r.label,
        group: r.group_name,
        online: hash.online === '1' || hash.online === 'true',
        lastSeenMs: r.last_seen ? r.last_seen.getTime() : null,
        agentVer: r.agent_ver,
        caps: hasCaps
          ? {
              projectMedia: (r.project_media as Caps['projectMedia']) ?? 'blocked',
              a11y: Boolean(r.a11y),
              knox: (r.knox as Caps['knox']) ?? 'unsupported',
              overlay: Boolean(r.overlay),
              secureSettings: Boolean(r.secure_settings),
            }
          : null,
        needsReprovisioning: r.needs_reprovisioning,
        volatile: {
          screenOn: hash.screenOn === '1' || hash.screenOn === 'true',
          charging: hash.charging === '1' || hash.charging === 'true',
          batteryPct: Number(hash.batteryPct ?? 0),
          net: hash.net ?? 'unknown',
          rssi: Number(hash.rssi ?? 0),
        },
        hw: hwFromHash(hash),
        lastSessionMs: lastSession.get(r.device_id) ?? null,
        drops24h: dropCount.get(r.device_id) ?? 0,
        hwEvents24h: hwEvents.get(r.device_id) ?? [],
      };
    });
    return { rows: dash, now };
  }

  async dashboard(operatorId: number) {
    const { rows, now } = await this.loadDashRows(operatorId);
    const names: Record<string, string> = {};
    for (const r of rows) if (r.label) names[r.deviceId] = r.label;
    return { ...summarizeFleet(rows, now), names };
  }

  /** Chi tiết từng máy đứng sau một chỉ số (`key` là khoá trong `lists`): dùng cho trang danh sách khi bấm vào ô số. */
  /**
   * Tiến độ một đợt cập nhật agent tới `target` (mặc định: phiên bản cao nhất đang chạy). Mỗi máy ở đúng một nhóm;
   * `complete` chỉ true khi cả fleet đã đúng phiên bản, đang online và khỏe.
   */
  async rollout(operatorId: number, targetRaw?: string) {
    if (targetRaw !== undefined && targetRaw !== '' && !isValidVersion(targetRaw)) {
      throw new BadRequestException({ code: 'BAD_TARGET', message: 'target must look like 1.4.8' });
    }
    const { rows, now } = await this.loadDashRows(operatorId);
    const probe = summarizeRollout(rows, '0.0.0', now);
    const target = targetRaw || probe.suggestedTarget || '0.0.0';
    const r = summarizeRollout(rows, target, now);
    // Danh sách deviceId theo nhóm đủ cho giao diện; chi tiết từng máy lấy qua /fleet/dashboard/rollout:<nhóm>:<phiên bản>.
    const { buckets, reasons, ...summary } = r;
    return { ...summary, problemDevices: Object.keys(reasons).length };
  }

  /** Các máy ở một nhóm rollout, kèm lý do (nếu có): dùng cho trang danh sách và script kiểm tra. */
  private async rolloutList(operatorId: number, key: string) {
    const m = /^rollout:([A-Za-z]+):(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(key);
    if (!m || !isRolloutBucket(m[1])) throw new NotFoundException();
    const { rows, now } = await this.loadDashRows(operatorId);
    const r = summarizeRollout(rows, m[2], now);
    const byId = new Map(rows.map((x) => [x.deviceId, x]));
    const out = r.buckets[m[1]].map((id) => ({ ...briefOf(byId.get(id)!), reasons: r.reasons[id] ?? [] }));
    return { key, count: out.length, generatedAt: now, rows: out };
  }

  async dashboardList(operatorId: number, key: string) {
    if (key.startsWith('rollout:')) return this.rolloutList(operatorId, key);
    const { rows, now } = await this.loadDashRows(operatorId);
    const lists = summarizeFleet(rows, now, 0).lists;
    // Chỉ khoá do chính dashboard tạo ra mới hợp lệ; chỉ số bằng 0 thì trả danh sách rỗng chứ không 404.
    const valid = KNOWN_LIST_KEYS.has(key) || /^ver:[\w.\-]{1,32}$/.test(key);
    if (!valid) throw new NotFoundException();
    const found = Object.hasOwn(lists, key) ? lists[key] : undefined;
    const ids = Array.isArray(found) ? found : undefined;
    const byId = new Map(rows.map((r) => [r.deviceId, r]));
    const out = (ids ?? []).map((id) => briefOf(byId.get(id)!));
    return { key, count: out.length, generatedAt: now, rows: out };
  }

  async connections(operatorId: number, hoursRaw?: number) {
    const hours = Math.min(720, Math.max(1, Number.isFinite(hoursRaw) ? Math.trunc(hoursRaw as number) : 24));
    const access = `(
      EXISTS (SELECT 1 FROM operator_group_access a WHERE a.operator_id = $1 AND a.group_id = d.group_id)
      OR EXISTS (SELECT 1 FROM operators WHERE id = $1 AND role IN ('admin', 'mdm_user') AND active = true)
    )`;
    const base = `FROM device_conn_events e
       JOIN devices d ON d.device_id = e.device_id
       WHERE e.source = 'broker' AND e.event = 'disconnected'
         AND e.at >= now() - make_interval(hours => $2::int) AND ${access}`;
    const reasons = await this.pg.pool.query<{ reason: string | null; n: number; devices: number }>(
      `SELECT e.reason, count(*)::int AS n, count(DISTINCT e.device_id)::int AS devices ${base}
       GROUP BY e.reason ORDER BY n DESC`,
      [operatorId, hours],
    );
    const top = await this.pg.pool.query<{ device_id: string; label: string | null; n: number; top_reason: string | null }>(
      `SELECT e.device_id, d.label, count(*)::int AS n,
              mode() WITHIN GROUP (ORDER BY e.reason) AS top_reason ${base}
       GROUP BY e.device_id, d.label ORDER BY n DESC LIMIT 20`,
      [operatorId, hours],
    );
    return {
      hours,
      byReason: reasons.rows.map((r) => ({
        reason: r.reason ?? 'unknown',
        count: r.n,
        devices: r.devices,
        hint: CONN_REASON_HINT[r.reason ?? ''] ?? null,
      })),
      topDevices: top.rows.map((r) => ({
        deviceId: r.device_id,
        label: r.label,
        disconnects: r.n,
        topReason: r.top_reason ?? 'unknown',
      })),
    };
  }

  async health() {
    const { rows } = await this.pg.pool.query<{
      device_id: string;
      agent_ver: string | null;
      project_media: string | null;
      a11y: boolean | null;
      knox: string | null;
      overlay: boolean | null;
      secure_settings: boolean | null;
      needs_reprovisioning: boolean;
    }>(
      `SELECT d.device_id, d.needs_reprovisioning, c.agent_ver, c.project_media, c.a11y, c.knox, c.overlay, c.secure_settings
       FROM devices d
       LEFT JOIN device_capabilities c ON c.device_id = d.device_id
       WHERE d.stale = false`,
    );

    const pipe = this.redis.pipeline();
    for (const r of rows) pipe.hgetall(keys.device(r.device_id));
    const live = (await pipe.exec()) ?? [];

    const counts = { total: rows.length, ready: 0, degraded: 0, notReady: 0, offline: 0 };
    const byBlocker: Record<string, number> = {};
    // Máy đang online mà thiếu quyền chỉ cấp được bằng ADB: cần danh sách để đi cấp.
    const missing = { secureSettings: 0, a11y: 0, overlay: 0 };

    rows.forEach((row, i) => {
      const hash = (live[i]?.[1] as Record<string, string>) ?? {};
      const state = rowToState(row, hash);
      const r = computeReadiness(state);
      if (r.tier !== 'OFFLINE' && row.agent_ver) {
        if (row.secure_settings === false) missing.secureSettings++;
        if (row.a11y === false) missing.a11y++;
        if (row.overlay === false) missing.overlay++;
      }
      if (r.tier === 'READY') counts.ready++;
      else if (r.tier === 'DEGRADED') counts.degraded++;
      else if (r.tier === 'NOT_READY') {
        counts.notReady++;
        for (const b of r.blockers ?? []) byBlocker[b.code] = (byBlocker[b.code] ?? 0) + 1;
      } else counts.offline++;
    });

    return { ...counts, byBlocker, missing };
  }
}

function rowToState(
  row: {
    agent_ver: string | null;
    project_media: string | null;
    a11y: boolean | null;
    knox: string | null;
    overlay: boolean | null;
    secure_settings: boolean | null;
    needs_reprovisioning: boolean;
  },
  hash: Record<string, string>,
): DeviceState {
  const caps: Caps = {
    projectMedia: (row.project_media as Caps['projectMedia']) ?? 'blocked',
    a11y: Boolean(row.a11y),
    knox: (row.knox as Caps['knox']) ?? 'unsupported',
    overlay: Boolean(row.overlay),
    secureSettings: Boolean(row.secure_settings),
  };
  const volatile: Volatile = {
    screenOn: hash.screenOn === '1' || hash.screenOn === 'true',
    charging: hash.charging === '1' || hash.charging === 'true',
    batteryPct: Number(hash.batteryPct ?? 0),
    net: hash.net ?? 'unknown',
    rssi: Number(hash.rssi ?? 0),
  };
  return {
    online: hash.online === '1' || hash.online === 'true',
    agentVer: row.agent_ver ?? '0.0.0',
    caps,
    volatile,
    needsReprovisioning: row.needs_reprovisioning,
  };
}
