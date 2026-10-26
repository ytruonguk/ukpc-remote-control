import { Injectable } from '@nestjs/common';
import { CONN_REASON_HINT, computeReadiness, keys, type Caps, type DeviceState, type Volatile } from '@rc/shared';
import { PgService, RedisService } from '../infra/infra.module';

@Injectable()
export class FleetService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

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
