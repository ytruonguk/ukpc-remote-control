import { Injectable } from '@nestjs/common';
import { computeReadiness, keys, type Caps, type DeviceState, type Volatile } from '@rc/shared';
import { PgService, RedisService } from '../infra/infra.module';

@Injectable()
export class FleetService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

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

    rows.forEach((row, i) => {
      const hash = (live[i]?.[1] as Record<string, string>) ?? {};
      const state = rowToState(row, hash);
      const r = computeReadiness(state);
      if (r.tier === 'READY') counts.ready++;
      else if (r.tier === 'DEGRADED') counts.degraded++;
      else if (r.tier === 'NOT_READY') {
        counts.notReady++;
        for (const b of r.blockers ?? []) byBlocker[b.code] = (byBlocker[b.code] ?? 0) + 1;
      } else counts.offline++;
    });

    return { ...counts, byBlocker };
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
