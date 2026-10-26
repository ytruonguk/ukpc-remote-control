import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { keys, mqttTopics } from '@rc/shared';
import { MqttService, PgService, RedisService } from '../infra/infra.module';
import { DevicesService } from './devices.service';

const DUMP_WAIT_SEC = 6;

function clamp(n: number | undefined, lo: number, hi: number, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

@Injectable()
export class HwService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly mqtt: MqttService,
    private readonly devices: DevicesService,
  ) {}

  private async assertDevice(deviceId: string, operatorId: number) {
    const found = await this.pg.pool.query(`SELECT 1 FROM devices WHERE device_id = $1`, [deviceId]);
    if (!found.rows[0]) throw new NotFoundException();
    await this.devices.assertGroupAccess(operatorId, deviceId);
  }

  /** Mẫu cũ → mới. `source`: hb = heartbeat (~2 phút), dump = hw.dump (~30 giây). */
  async samples(deviceId: string, operatorId: number, q: { minutes?: number; limit?: number }) {
    await this.assertDevice(deviceId, operatorId);
    const minutes = clamp(q.minutes, 5, 7 * 24 * 60, 360);
    const limit = clamp(q.limit, 1, 2000, 720);
    const { rows } = await this.pg.pool.query<{ source: string; data: Record<string, unknown> }>(
      `SELECT source, data
       FROM device_hw_samples
       WHERE device_id = $1 AND sample_ts >= now() - make_interval(mins => $2::int)
       ORDER BY sample_ts DESC
       LIMIT $3`,
      [deviceId, minutes, limit],
    );
    return rows.reverse().map((r) => ({ source: r.source, ...r.data }));
  }

  async events(deviceId: string, operatorId: number, limitRaw?: number) {
    await this.assertDevice(deviceId, operatorId);
    const limit = clamp(limitRaw, 1, 500, 100);
    const { rows } = await this.pg.pool.query<{ code: string; msg: string | null; ts: string; at: string }>(
      `SELECT code, msg,
              (extract(epoch FROM ts) * 1000)::bigint AS ts,
              (extract(epoch FROM at) * 1000)::bigint AS at
       FROM device_hw_events
       WHERE device_id = $1
       ORDER BY at DESC
       LIMIT $2`,
      [deviceId, limit],
    );
    return rows.map((r) => ({ code: r.code, msg: r.msg, ts: Number(r.ts), at: Number(r.at) }));
  }

  /** Gửi hw.dump và chờ máy trả lời; mẫu đã được ingest ghi DB, ở đây chỉ báo kết quả. */
  async dump(deviceId: string, operatorId: number, nRaw?: number) {
    await this.assertDevice(deviceId, operatorId);
    const n = clamp(nRaw, 1, 100, 100);
    // Bấm liên tục "Dump now" không được dồn lệnh xuống máy.
    const free = await this.redis.set(`hw:dumpthr:${deviceId}`, '1', 'EX', 3, 'NX');
    if (!free) return { ok: false as const, reason: 'THROTTLED' as const };
    const nonce = randomUUID();
    const key = keys.hwDump(nonce);
    await this.redis.set(keys.hwDumpReq(nonce), '1', 'EX', DUMP_WAIT_SEC + 10);
    await this.mqtt.publish(mqttTopics.cmd(deviceId), { type: 'hw.dump', n, nonce }, { qos: 1 });
    // BRPOP chặn cả kết nối: dùng kết nối riêng để các lệnh Redis khác của API không bị treo theo.
    const blocker = this.redis.duplicate();
    let res: [string, string] | null;
    try {
      res = await blocker.brpop(key, DUMP_WAIT_SEC);
    } finally {
      blocker.disconnect();
    }
    await this.redis.del(key, keys.hwDumpReq(nonce));
    if (!res) return { ok: false as const, reason: 'TIMEOUT' as const };
    const body = JSON.parse(res[1]) as { count: number; inserted: number };
    return { ok: true as const, count: body.count, inserted: body.inserted };
  }
}
