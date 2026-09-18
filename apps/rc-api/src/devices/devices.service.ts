import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { computeReadiness, keys, type Caps, type DeviceState, type Readiness, type Volatile } from '@rc/shared';
import { mqttTopics } from '@rc/shared';
import { PgService, RedisService, MqttService } from '../infra/infra.module';

type DeviceRow = {
  device_id: string;
  label: string | null;
  model: string | null;
  last_seen: Date | null;
  android_id: string | null;
  needs_reprovisioning: boolean;
  group_name: string | null;
  group_id: number | null;
  agent_ver: string | null;
  project_media: string | null;
  a11y: boolean | null;
  knox: string | null;
  overlay: boolean | null;
  secure_settings: boolean | null;
  encoder_name: string | null;
  encoder_hw: boolean | null;
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly mqtt: MqttService,
  ) {}

  async assertGroupAccess(operatorId: number, deviceId: string) {
    const { rows } = await this.pg.pool.query(
      `SELECT 1
       FROM devices d
       JOIN operator_group_access a ON a.group_id = d.group_id
       JOIN operators o ON o.id = a.operator_id
       WHERE d.device_id = $1 AND a.operator_id = $2 AND o.active = true
       UNION
       SELECT 1 FROM operators WHERE id = $2 AND role = 'admin'`,
      [deviceId, operatorId],
    );
    if (!rows.length) throw new ForbiddenException('NO_GROUP_ACCESS');
  }

  async list(params: { group?: string; tier?: string; q?: string; page?: number }, operatorId: number) {
    const page = Math.max(1, params.page ?? 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const { rows } = await this.pg.pool.query<DeviceRow>(
      `SELECT d.device_id, d.label, d.model, d.last_seen, d.android_id, d.needs_reprovisioning,
              g.name AS group_name, g.id AS group_id,
              c.agent_ver, c.project_media, c.a11y, c.knox, c.overlay,
              c.secure_settings, c.encoder_name, c.encoder_hw
       FROM devices d
       LEFT JOIN device_groups g ON g.id = d.group_id
       LEFT JOIN device_capabilities c ON c.device_id = d.device_id
       WHERE d.stale = false
         AND (
           EXISTS (
             SELECT 1 FROM operator_group_access a
             WHERE a.operator_id = $1 AND a.group_id = d.group_id
           )
           OR EXISTS (SELECT 1 FROM operators WHERE id = $1 AND role = 'admin')
         )
         AND ($2::text IS NULL OR g.name = $2)
         AND ($3::text IS NULL OR d.device_id ILIKE '%'||$3||'%' OR COALESCE(d.label,'') ILIKE '%'||$3||'%')
       ORDER BY d.last_seen DESC NULLS LAST
       LIMIT $4 OFFSET $5`,
      [operatorId, params.group ?? null, params.q ?? null, limit, offset],
    );

    const pipe = this.redis.pipeline();
    for (const row of rows) pipe.hgetall(keys.device(row.device_id));
    const live = (await pipe.exec()) ?? [];

    const items = rows.map((row, i) => {
      const hash = (live[i]?.[1] as Record<string, string>) ?? {};
      const state = toDeviceState(row, hash);
      const readiness = computeReadiness(state);
      return this.toDto(row, state, readiness);
    });

    return params.tier ? items.filter((d) => d.readiness.tier === params.tier) : items;
  }

  async get(deviceId: string, operatorId: number) {
    await this.assertGroupAccess(operatorId, deviceId);
    const { rows } = await this.pg.pool.query<DeviceRow>(
      `SELECT d.device_id, d.label, d.model, d.last_seen, d.android_id, d.needs_reprovisioning,
              g.name AS group_name, g.id AS group_id,
              c.agent_ver, c.project_media, c.a11y, c.knox, c.overlay,
              c.secure_settings, c.encoder_name, c.encoder_hw
       FROM devices d
       LEFT JOIN device_groups g ON g.id = d.group_id
       LEFT JOIN device_capabilities c ON c.device_id = d.device_id
       WHERE d.device_id = $1`,
      [deviceId],
    );
    if (!rows[0]) throw new NotFoundException();
    const hash = await this.redis.hgetall(keys.device(deviceId));
    const state = toDeviceState(rows[0], hash);
    return this.toDto(rows[0], state, computeReadiness(state));
  }

  async getState(deviceId: string): Promise<DeviceState> {
    const { rows } = await this.pg.pool.query<DeviceRow>(
      `SELECT d.device_id, d.label, d.model, d.last_seen, d.android_id, d.needs_reprovisioning,
              g.name AS group_name, g.id AS group_id,
              c.agent_ver, c.project_media, c.a11y, c.knox, c.overlay,
              c.secure_settings, c.encoder_name, c.encoder_hw
       FROM devices d
       LEFT JOIN device_groups g ON g.id = d.group_id
       LEFT JOIN device_capabilities c ON c.device_id = d.device_id
       WHERE d.device_id = $1`,
      [deviceId],
    );
    const hash = await this.redis.hgetall(keys.device(deviceId));
    return toDeviceState(rows[0] ?? emptyRow(deviceId), hash);
  }

  async probe(deviceId: string, timeoutMs: number): Promise<boolean> {
    const waitKey = `probe:wait:${deviceId}`;
    await this.redis.del(waitKey);
    await this.mqtt.publish(mqttTopics.cmd(deviceId), { type: 'probe' }, { qos: 1 });
    const result = await this.redis.brpop(waitKey, Math.ceil(timeoutMs / 1000));
    return Boolean(result);
  }

  async selfheal(deviceId: string, operatorId: number) {
    await this.assertGroupAccess(operatorId, deviceId);
    await this.mqtt.publish(mqttTopics.cmd(deviceId), { type: 'selfheal' }, { qos: 1 });
    return { ok: true };
  }

  private toDto(row: DeviceRow, state: DeviceState, readiness: Readiness) {
    return {
      deviceId: row.device_id,
      label: row.label,
      model: row.model,
      group: row.group_name,
      lastSeen: row.last_seen,
      needsReprovisioning: row.needs_reprovisioning,
      readiness,
      volatile: state.volatile,
      caps: state.caps,
      agentVer: state.agentVer,
      online: state.online,
    };
  }
}

function emptyRow(deviceId: string): DeviceRow {
  return {
    device_id: deviceId,
    label: null,
    model: null,
    last_seen: null,
    android_id: null,
    needs_reprovisioning: false,
    group_name: null,
    group_id: null,
    agent_ver: null,
    project_media: null,
    a11y: null,
    knox: null,
    overlay: null,
    secure_settings: null,
    encoder_name: null,
    encoder_hw: null,
  };
}

function toDeviceState(row: DeviceRow, hash: Record<string, string>): DeviceState {
  const caps: Caps = {
    projectMedia: (row.project_media as Caps['projectMedia']) ?? 'blocked',
    a11y: Boolean(row.a11y),
    knox: (row.knox as Caps['knox']) ?? 'unsupported',
    overlay: Boolean(row.overlay),
    secureSettings: Boolean(row.secure_settings),
    encoder: row.encoder_name ? { name: row.encoder_name, hw: Boolean(row.encoder_hw) } : undefined,
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
  };
}
