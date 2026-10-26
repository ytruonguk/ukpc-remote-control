import { Injectable, NotFoundException } from '@nestjs/common';
import { CONN_REASON_HINT } from '@rc/shared';
import { PgService } from '../infra/infra.module';
import { DevicesService } from './devices.service';

function clampHours(h: number | undefined): number {
  if (h === undefined || !Number.isFinite(h)) return 24;
  return Math.min(720, Math.max(1, Math.trunc(h)));
}

@Injectable()
export class ConnService {
  constructor(
    private readonly pg: PgService,
    private readonly devices: DevicesService,
  ) {}

  /** Vì sao máy này ngắt/nối lại: số lần theo lý do (broker), thời gian giữ kết nối, và dòng thời gian chi tiết. */
  async device(deviceId: string, operatorId: number, hoursRaw?: number) {
    const found = await this.pg.pool.query(`SELECT 1 FROM devices WHERE device_id = $1`, [deviceId]);
    if (!found.rows[0]) throw new NotFoundException();
    await this.devices.assertGroupAccess(operatorId, deviceId);
    const hours = clampHours(hoursRaw);

    const reasons = await this.pg.pool.query<{ reason: string | null; n: number }>(
      `SELECT reason, count(*)::int AS n
       FROM device_conn_events
       WHERE device_id = $1 AND source = 'broker' AND event = 'disconnected'
         AND at >= now() - make_interval(hours => $2::int)
       GROUP BY reason ORDER BY n DESC`,
      [deviceId, hours],
    );
    const stats = await this.pg.pool.query<{ connects: number; disconnects: number; avg_s: number | null; min_s: number | null }>(
      `SELECT count(*) FILTER (WHERE event = 'connected')::int AS connects,
              count(*) FILTER (WHERE event = 'disconnected')::int AS disconnects,
              round(avg(extract(epoch FROM (at - connected_at)))
                    FILTER (WHERE event = 'disconnected' AND connected_at IS NOT NULL))::int AS avg_s,
              round(min(extract(epoch FROM (at - connected_at)))
                    FILTER (WHERE event = 'disconnected' AND connected_at IS NOT NULL))::int AS min_s
       FROM device_conn_events
       WHERE device_id = $1 AND source = 'broker' AND at >= now() - make_interval(hours => $2::int)`,
      [deviceId, hours],
    );
    const events = await this.pg.pool.query<{
      source: string;
      event: string;
      reason: string | null;
      at: string;
      ip: string | null;
      keepalive: number | null;
      detail: Record<string, unknown> | null;
    }>(
      `SELECT source, event, reason, (extract(epoch FROM at) * 1000)::bigint AS at, ip, keepalive, detail
       FROM device_conn_events
       WHERE device_id = $1 AND at >= now() - make_interval(hours => $2::int)
       ORDER BY at DESC
       LIMIT 100`,
      [deviceId, hours],
    );
    const s = stats.rows[0];
    return {
      hours,
      connects: s?.connects ?? 0,
      disconnects: s?.disconnects ?? 0,
      avgSessionSec: s?.avg_s ?? null,
      shortestSessionSec: s?.min_s ?? null,
      byReason: reasons.rows.map((r) => ({
        reason: r.reason ?? 'unknown',
        count: r.n,
        hint: CONN_REASON_HINT[r.reason ?? ''] ?? null,
      })),
      events: events.rows.map((e) => ({ ...e, at: Number(e.at) })),
    };
  }
}
